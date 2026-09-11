import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { searchDreamingEvidenceInDb } from "./dreaming-capabilities";

/**
 * A deliberate sourceRef read must be able to carry far more than a listing
 * excerpt. At 2k chars a 200 KB transcript needs 100 turns and never finishes
 * inside a pass, which is what froze the episodic backlog.
 */
describe("dreaming evidence fragment size", () => {
	let dir = "";
	const BIG = "x".repeat(120_000);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-evidence-fragment-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
				  project, harness, captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/big.md', 'sha-big', 'source_obsidian_markdown', 's', 's', 't',
				  '/repo', 'obsidian', '2026-08-01T10:00:00.000Z', ?, '2026-08-01T10:00:00.000Z', 0)`,
			).run(BIG);
		});
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function contentLength(item: unknown): number {
		if (item === null || typeof item !== "object" || !("content" in item)) return 0;
		const content = item.content;
		return typeof content === "string" ? content.length : 0;
	}

	function readFragment(chunkSize?: number): number {
		const result = getDbAccessor().withReadDb((db) =>
			searchDreamingEvidenceInDb(db, {
				agentId: "ant",
				sourceRef: "artifact:sources/big.md",
				offset: 0,
				...(chunkSize === undefined ? {} : { chunkSize }),
			}),
		);
		expect(result.ok).toBe(true);
		return contentLength((result.items ?? [])[0]);
	}

	it("honours a requested chunk larger than a listing excerpt", () => {
		expect(readFragment(16_000)).toBeGreaterThan(15_000);
	});

	it("defaults well above the 2k listing excerpt", () => {
		expect(readFragment()).toBeGreaterThan(4_000);
	});

	it("still caps an unbounded request so one turn cannot swallow the context", () => {
		expect(readFragment(500_000)).toBeLessThanOrEqual(20_000);
	});

	it("keeps query listings on the small excerpt budget", () => {
		const listing = getDbAccessor().withReadDb((db) => searchDreamingEvidenceInDb(db, { agentId: "ant", query: "x" }));
		expect(listing.ok).toBe(true);
		for (const item of listing.items ?? []) {
			expect(contentLength(item)).toBeLessThanOrEqual(2_000);
		}
	});

	it("delivers a real bite on the scan path, which is what the backlog drains through", () => {
		const scan = getDbAccessor().withReadDb((db) => searchDreamingEvidenceInDb(db, { agentId: "ant" }));
		expect(scan.ok).toBe(true);
		const delivered = (scan.items ?? []).reduce((sum, item) => sum + contentLength(item), 0);
		expect(delivered).toBeGreaterThan(2_000);
	});

	it("bounds a whole scan response so one turn cannot swallow the context", () => {
		getDbAccessor().withWriteTx((db) => {
			for (let i = 0; i < 8; i += 1) {
				db.prepare(
					`INSERT INTO memory_artifacts
					 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
					  project, harness, captured_at, content, updated_at, is_deleted)
					 VALUES ('ant', ?, ?, 'source_obsidian_markdown', 's', 's', 't',
					  '/repo', 'obsidian', '2026-08-01T10:00:00.000Z', ?, '2026-08-01T10:00:00.000Z', 0)`,
				).run(`sources/bulk-${i}.md`, `sha-bulk-${i}`, BIG);
			}
		});
		const scan = getDbAccessor().withReadDb((db) => searchDreamingEvidenceInDb(db, { agentId: "ant" }));
		expect(scan.ok).toBe(true);
		const delivered = (scan.items ?? []).reduce((sum, item) => sum + contentLength(item), 0);
		expect(delivered).toBeLessThanOrEqual(32_000 + 20_000);
	});
});
