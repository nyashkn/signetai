import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { type SourceParticipant, indexSourceParticipants } from "./source-participant-graph";

describe("display-name aliases from participants", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-participants-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		insertEntity("ent_doc", "Sales Cycle Time", "sales cycle time", "artifact");
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function insertEntity(id: string, name: string, canonicalName: string, entityType: string): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'default', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			).run(id, name, canonicalName, entityType);
		});
	}

	function index(participants: readonly SourceParticipant[]): ReturnType<typeof indexSourceParticipants> {
		return indexSourceParticipants({
			agentId: "default",
			sourceId: "src_email",
			sourceKind: "source_email_message",
			sourceRoot: "email://pivotplanit",
			sourcePath: "email://pivotplanit/INBOX/179",
			documentEntityId: "ent_doc",
			participants,
		});
	}

	function aliases(): Array<{
		alias: string;
		canonical_alias: string;
		alias_kind: string | null;
		confidence: number;
		entity_id: string;
		source: string | null;
	}> {
		return getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					"SELECT alias, canonical_alias, alias_kind, confidence, entity_id, source FROM entity_aliases WHERE status = 'active' ORDER BY canonical_alias",
				)
				.all(),
		) as Array<{
			alias: string;
			canonical_alias: string;
			alias_kind: string | null;
			confidence: number;
			entity_id: string;
			source: string | null;
		}>;
	}

	const fromMatt: SourceParticipant = {
		identifier: "matt@dock-blocks.com",
		displayName: "Matt West",
		edgeType: "authored_by",
		strength: 1,
		reason: "user-asserted: From header of <msg-179@dock-blocks.com>",
	};

	it("records the name↔address pairing the From header asserts", () => {
		// Without this the graph keeps `Matt West` and `matt@dock-blocks.com` as
		// unrelated rows that differ in both name and type, which no exact
		// canonical-name check can ever join.
		const result = index([fromMatt]);
		expect(result.aliasesWritten).toBe(1);

		const rows = aliases();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.alias).toBe("Matt West");
		expect(rows[0]?.canonical_alias).toBe("matt west");
		expect(rows[0]?.alias_kind).toBe("display_name");
		expect(rows[0]?.confidence).toBe(1);
		expect(rows[0]?.source).toBe("user-asserted: From header of <msg-179@dock-blocks.com>");

		const person = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT id FROM entities WHERE canonical_name = 'matt@dock-blocks.com'").get(),
		) as { id: string } | null;
		expect(rows[0]?.entity_id).toBe(person?.id ?? "");
	});

	it("enters a quoted-block pairing at the strength of its witness", () => {
		expect(index([{ ...fromMatt, strength: 0.8, reason: "user-asserted: quoted from block" }]).aliasesWritten).toBe(1);
		expect(aliases()[0]?.confidence).toBe(0.8);
	});

	it("drops a display name that already names an organization", () => {
		// Real header from the live corpus: `Dock Blocks <matt@dock-blocks.com>`.
		// The company signs the mail; the human sends it. Writing that alias would
		// make every later lookup of the organization resolve to Matt.
		insertEntity("ent_org", "Dock Blocks", "dock blocks", "organization");
		const result = index([{ ...fromMatt, displayName: "Dock Blocks" }]);
		expect(result.aliasesWritten).toBe(0);
		expect(aliases()).toHaveLength(0);
	});

	it("leaves an alias another entity already claims alone", () => {
		// One handle resolves to one entity. A header arriving later does not
		// outrank a declared principal — the collision is a merge candidate.
		insertEntity("ent_kn", "KN", "kn", "person");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, alias_kind, confidence, source, status, created_at, updated_at)
				 VALUES ('alias_kn', 'ent_kn', 'default', 'Matt West', 'matt west', 'display_name', 1.0, 'principal-declaration', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			).run();
		});

		expect(index([fromMatt]).aliasesWritten).toBe(0);
		const rows = aliases();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.entity_id).toBe("ent_kn");
	});

	it("resolves a linked-away spelling to its holder instead of re-minting it", () => {
		// The next sync sees `Jui` again. Without this the row someone
		// deliberately linked away comes back as its own person and starts
		// accreting edges, so the link has to be redone after every sync forever.
		insertEntity("ent_principal", "njui@pivotplanit.com", "njui@pivotplanit.com", "person");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, alias_kind, confidence, source, status, created_at, updated_at)
				 VALUES ('alias_jui', 'ent_principal', 'default', 'Jui', 'jui', 'display_name', 1.0, 'operator: dashboard', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			).run();
		});

		index([{ identifier: "Jui", edgeType: "authored_by", strength: 1, reason: "user-asserted: From header" }]);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM entities WHERE agent_id = 'default' AND canonical_name = 'jui'").all() as Array<{
					id: string;
				}>,
		);
		expect(rows).toHaveLength(0);

		const edges = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT target_entity_id FROM entity_dependencies WHERE agent_id = 'default' AND dependency_type = 'authored_by'",
					)
					.all() as Array<{ target_entity_id: string }>,
		);
		expect(edges.map((row) => row.target_entity_id)).toEqual(["ent_principal"]);
	});

	it("does not alias a display name that merely repeats the address", () => {
		expect(index([{ ...fromMatt, displayName: "matt@dock-blocks.com" }]).aliasesWritten).toBe(0);
		expect(aliases()).toHaveLength(0);
	});
});
