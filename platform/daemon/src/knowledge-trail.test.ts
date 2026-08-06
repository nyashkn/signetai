import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { identityTimeline, trailFrom, whatTouched, whoTouched } from "./knowledge-trail";
import { resolveFocalEntities } from "./pipeline/graph-traversal";

describe("trail queries", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-trail-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		seed();
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function entity(id: string, name: string, type: string, sourcePath: string | null = null): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions,
				 created_at, updated_at, source_kind, source_path)
				 VALUES (?, ?, ?, ?, 'default', 5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, ?)`,
			).run(id, name, name.toLowerCase(), type, sourcePath === null ? null : "source_email_message", sourcePath);
		});
	}

	function edge(id: string, from: string, to: string, type: string, sourcePath: string | null = null): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence,
				  created_at, updated_at, source_kind, source_path)
				 VALUES (?, ?, ?, 'default', ?, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, ?)`,
			).run(id, from, to, type, sourcePath === null ? null : "source_email_message", sourcePath);
		});
	}

	function artifact(path: string, messageId: string): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at,
				  content, updated_at, is_deleted, source_meta_json)
				 VALUES ('default', ?, 'sha', 'source_email_message', 'sess', 'tok', '2026-07-10T09:00:00.000Z',
				         'body', '2026-07-10T09:00:00.000Z', 0, ?)`,
			).run(path, JSON.stringify({ provider: "email", messageId }));
		});
	}

	const PATH = "email://pivotplanit/Inbox/messages/%3Cm1@dock-blocks.com%3E";

	/**
	 * Matt exists twice — as the name extraction found and as the address the
	 * connector keyed on — with a header-asserted alias between them, which is
	 * exactly the state P4 leaves the graph in before any merge is approved.
	 */
	function seed(): void {
		entity("ent-matt", "Matt West", "person");
		entity("ent-matt-addr", "matt@dock-blocks.com", "person");
		entity("ent-msg", "Sales Cycle Time", "source_document", PATH);
		entity("ent-thread", "Sales Cycle Time thread", "source_document");
		entity("ent-mailbox", "Inbox (pivotplanit)", "source_document");
		entity("ent-alecia", "Alecia", "person");
		artifact(PATH, "m1@dock-blocks.com");

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_aliases
				 (id, entity_id, agent_id, alias, canonical_alias, alias_kind, confidence, source, status, created_at, updated_at)
				 VALUES ('al-matt', 'ent-matt-addr', 'default', 'Matt West', 'matt west', 'display_name', 1.0,
				         'user-asserted: From header', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			).run();
		});

		// Direction is the connector's: the artifact points at the people.
		edge("dep-auth", "ent-msg", "ent-matt-addr", "authored_by", PATH);
		edge("dep-to", "ent-msg", "ent-alecia", "addressed_to", PATH);
		edge("dep-thread", "ent-thread", "ent-msg", "contains");
		edge("dep-mailbox", "ent-mailbox", "ent-thread", "contains");
	}

	it("finds a person's work through the address the connector keyed on", () => {
		// "Matt West" is the extracted person and holds no edges at all; every
		// message hangs off `matt@dock-blocks.com`. Without alias expansion this
		// returns nothing, which is what the graph did before P4.
		const result = whatTouched({ agentId: "default", selector: "Matt West" });

		expect([...result.identity.entityIds].sort()).toEqual(["ent-matt", "ent-matt-addr"]);
		expect(result.items.map((item) => item.name)).toEqual(["Sales Cycle Time"]);
		expect(result.items[0]?.relation).toBe("authored_by");
		expect(result.items[0]?.deepLink).toBe("message://%3cm1%40dock-blocks.com%3e");
	});

	it("answers the same for every spelling of one identity", () => {
		const byName = whatTouched({ agentId: "default", selector: "Matt West" });
		const byAddress = whatTouched({ agentId: "default", selector: "matt@dock-blocks.com" });
		const byId = whatTouched({ agentId: "default", selector: "ent-matt" });

		const ids = (result: typeof byName): string[] => [...result.identity.entityIds].sort();
		expect(ids(byAddress)).toEqual(ids(byName));
		expect(ids(byId)).toEqual(ids(byName));
	});

	it("walks past one hop, following authored_by backwards", () => {
		// The whole point: `traverseKnowledgeGraph` expands exactly one dependency
		// hop, and `authored_by` runs artifact->person, so a person's own thread
		// was unreachable in either direction.
		const result = trailFrom({ agentId: "default", selector: "Matt West", maxDepth: 4 });

		const deepest = result.paths.filter((path) => path.depth === 3);
		expect(deepest.length).toBeGreaterThan(0);
		expect(deepest[0]?.hops.map((hop) => hop.name)).toEqual([
			"matt@dock-blocks.com",
			"Sales Cycle Time",
			"Sales Cycle Time thread",
			"Inbox (pivotplanit)",
		]);
		expect(deepest[0]?.hops.map((hop) => hop.relation)).toEqual([null, "authored_by", "contains", "contains"]);
		expect(deepest[0]?.hops[1]?.deepLink).toBe("message://%3cm1%40dock-blocks.com%3e");
	});

	it("reaches a second person through the message they shared", () => {
		const result = trailFrom({ agentId: "default", selector: "Matt West", targetTypes: ["person"] });
		const names = result.paths.map((path) => path.hops[path.hops.length - 1]?.name);
		expect(names).toContain("Alecia");
	});

	it("respects the depth bound", () => {
		const shallow = trailFrom({ agentId: "default", selector: "Matt West", maxDepth: 1 });
		expect(shallow.paths.every((path) => path.depth <= 1)).toBe(true);
		expect(shallow.paths.length).toBeGreaterThan(0);
	});

	it("does not walk in circles", () => {
		edge("dep-cycle", "ent-mailbox", "ent-msg", "contains");
		const result = trailFrom({ agentId: "default", selector: "Matt West", maxDepth: 6 });
		for (const path of result.paths) {
			const ids = path.hops.map((hop) => hop.entityId);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	it("resolves a chained alias cluster the same way from either end", () => {
		// Aliases chain: a principal declaration puts "KN" beside one address
		// while a header puts a second address beside the first. One hop from
		// "KN" never reaches the far end, so the answer used to depend on which
		// spelling the caller happened to type.
		entity("ent-kn", "KN", "person");
		entity("ent-pvt", "njui@pivotplanit.com", "person");
		entity("ent-gmail", "nyashkn@gmail.com", "person");
		getDbAccessor().withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO entity_aliases
				 (id, entity_id, agent_id, alias, canonical_alias, alias_kind, confidence, source, status, created_at, updated_at)
				 VALUES (?, ?, 'default', ?, ?, 'email', 1.0, 'user-asserted: test', 'active',
				         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			);
			// KN -> njui@pivotplanit.com
			insert.run("al-kn", "ent-kn", "njui@pivotplanit.com", "njui@pivotplanit.com");
			// njui@pivotplanit.com -> nyashkn@gmail.com
			insert.run("al-pvt", "ent-pvt", "nyashkn@gmail.com", "nyashkn@gmail.com");
		});

		const expected = ["ent-gmail", "ent-kn", "ent-pvt"];
		for (const selector of ["KN", "njui@pivotplanit.com", "nyashkn@gmail.com", "ent-gmail"]) {
			const identity = whatTouched({ agentId: "default", selector }).identity;
			expect({ selector, ids: [...identity.entityIds].sort() }).toEqual({ selector, ids: expected });
		}
	});

	it("starts a traversal from the whole identity, not the spelling that matched", () => {
		// Focal resolution matches names and tokens, so a linked-but-unmerged pair
		// resolved to whichever spelling the query used and the walk began from
		// half the person. `what_touched` has folded them since P5 — browsing the
		// graph contradicted querying it. Recall shares this resolver, so both
		// read paths move together.
		//
		// The two spellings share no token on purpose: `matt@dock-blocks.com` FTS
		// -tokenizes to `matt`, so a Matt fixture would pass without any expansion
		// at all and prove nothing.
		entity("ent-russ", "Russ Watts", "person");
		entity("ent-russ-addr", "rwatts@example.com", "person");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_aliases
				 (id, entity_id, agent_id, alias, canonical_alias, alias_kind, confidence, source, status, created_at, updated_at)
				 VALUES ('al-russ', 'ent-russ-addr', 'default', 'Russ Watts', 'russ watts', 'display_name', 1.0,
				         'user-asserted: From header', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			).run();
		});

		const focal = getDbAccessor().withReadDb((db) =>
			resolveFocalEntities(db, "default", { queryTokens: ["russ", "watts"], includePinned: false }),
		);
		expect(focal.entityIds).toContain("ent-russ");
		expect(focal.entityIds).toContain("ent-russ-addr");
	});

	it("answers who touched a thing with one row per actor", () => {
		// The message has two people on it and the artifact rows besides. A person
		// on a twelve-message thread is one answer to "who touched this", not
		// twelve, so the rollup is the point rather than a formatting nicety.
		const result = whoTouched({ agentId: "default", selector: "Sales Cycle Time" });

		expect(result.actors.map((actor) => actor.name).sort()).toEqual(["Alecia", "matt@dock-blocks.com"]);
		const matt = result.actors.find((actor) => actor.name === "matt@dock-blocks.com");
		expect(matt?.relations).toEqual(["authored_by"]);
		// Source documents are on the other end of those edges too and are not actors.
		expect(result.actors.every((actor) => actor.entityType === "person")).toBe(true);
	});

	it("reads one identity's activity forwards across sources", () => {
		const result = identityTimeline({ agentId: "default", selector: "Matt West" });

		expect(result.entries.map((entry) => entry.name)).toEqual(["Sales Cycle Time"]);
		expect(result.entries[0]?.at).toBe("2026-07-10T09:00:00.000Z");
		expect(result.entries[0]?.deepLink).toBe("message://%3cm1%40dock-blocks.com%3e");

		// A window that excludes the only dated edge returns nothing rather than
		// falling back to everything.
		expect(identityTimeline({ agentId: "default", selector: "Matt West", until: "2026-01-01" }).entries).toEqual([]);
	});

	it("returns an empty answer rather than throwing for an unknown selector", () => {
		const result = whatTouched({ agentId: "default", selector: "nobody at all" });
		expect(result.identity.matchedVia).toBe("none");
		expect(result.items).toEqual([]);
		expect(trailFrom({ agentId: "default", selector: "nobody at all" }).paths).toEqual([]);
	});
});
