import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { SourceIngestError, assertIngestNotDegraded, snapshotSourceIngest } from "./source-ingest-gate";

describe("source ingest gate", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-ingest-gate-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function artifact(path: string, content: string, bodyFetched: boolean, deleted = false): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted, source_meta_json)
				 VALUES ('default', 'src-1', ?, 'sha', 'source_email_message', 'sess', 'tok',
				         '2026-07-10T09:00:00.000Z', ?, '2026-07-10T09:00:00.000Z', ?, ?)`,
			).run(path, content, deleted ? 1 : 0, JSON.stringify({ bodyFetched }));
		});
	}

	function setBody(path: string, content: string, bodyFetched: boolean): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE memory_artifacts SET content = ?, source_meta_json = ?
				 WHERE agent_id = 'default' AND source_id = 'src-1' AND source_path = ?`,
			).run(content, JSON.stringify({ bodyFetched }), path);
		});
	}

	it("fails a sync that replaced a stored body with headers alone", () => {
		artifact("m/1", "# Subject\n\nNumbers below", true);
		const before = snapshotSourceIngest("default", "src-1");

		setBody("m/1", "# Subject\n", false);

		expect(() => assertIngestNotDegraded("default", "src-1", before)).toThrow(SourceIngestError);
	});

	it("accepts a body that left with its message", () => {
		// Mail really does get deleted, and the stale purge follows it. Only a
		// path that is still live may not lose the body it had.
		artifact("m/1", "# Subject\n\nNumbers below", true);
		const before = snapshotSourceIngest("default", "src-1");

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memory_artifacts SET is_deleted = 1 WHERE source_path = 'm/1'").run();
		});

		expect(() => assertIngestNotDegraded("default", "src-1", before)).not.toThrow();
	});

	it("fails a row that claims a fetched body it does not have", () => {
		const before = snapshotSourceIngest("default", "src-1");
		artifact("m/2", "", true);

		expect(() => assertIngestNotDegraded("default", "src-1", before)).toThrow(/no content/);
	});

	it("passes a sync that only added messages", () => {
		artifact("m/1", "# One\n\nbody", true);
		const before = snapshotSourceIngest("default", "src-1");
		artifact("m/2", "# Two\n\nbody", true);
		artifact("m/3", "# Three\n", false);

		expect(() => assertIngestNotDegraded("default", "src-1", before)).not.toThrow();
	});
});
