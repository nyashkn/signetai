import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { registerKnowledgeRoutes } from "./knowledge-routes";
import { resetAuthStateForTests } from "./state";

/**
 * A dropped query parameter is invisible from the outside: the route still
 * answers 200 and the payload still looks like a trail, it is merely the wrong
 * one. `whatTouched` has applied `since`/`until` in its SQL since P5 while this
 * route forwarded neither, so a caller asking for "before July" got everything
 * and had no way to tell.
 */
describe("GET /api/knowledge/touched time window", () => {
	let dir = "";
	let app: Hono;

	function seedEntity(id: string, name: string, entityType = "person"): void {
		const ts = "2026-01-01T00:00:00.000Z";
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'default', 0, ?, ?)`,
			).run(id, name, name.toLowerCase(), entityType, ts, ts);
		});
	}

	/** No artifact row, so `COALESCE(a.captured_at, d.created_at)` dates the edge itself. */
	function seedEdge(id: string, from: string, to: string, createdAt: string): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, reason, status,
				  created_at, updated_at)
				 VALUES (?, ?, ?, 'default', 'authored_by', 1.0, 'test', 'active', ?, ?)`,
			).run(id, from, to, createdAt, createdAt);
		});
	}

	async function touched(query: string): Promise<ReadonlyArray<{ entityId: string }>> {
		const res = await app.request(`/api/knowledge/touched?${query}`);
		expect(res.status).toBe(200);
		return ((await res.json()) as { items: Array<{ entityId: string }> }).items;
	}

	beforeEach(() => {
		resetAuthStateForTests();
		dir = mkdtempSync(join(tmpdir(), "signet-trail-routes-"));
		closeDbAccessor();
		initDbAccessor(join(dir, "memories.db"));
		app = new Hono();
		registerKnowledgeRoutes(app);

		seedEntity("e-matt", "Matt West");
		seedEntity("e-old", "June Thread", "artifact");
		seedEntity("e-new", "August Thread", "artifact");
		seedEdge("d-old", "e-old", "e-matt", "2026-06-15T00:00:00.000Z");
		seedEdge("d-new", "e-new", "e-matt", "2026-08-15T00:00:00.000Z");
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns every dated item when no window is given", async () => {
		const items = await touched("who=Matt%20West");
		expect(items.map((item) => item.entityId).sort()).toEqual(["e-new", "e-old"]);
	});

	it("honours until", async () => {
		const items = await touched("who=Matt%20West&until=2026-07-01T00:00:00.000Z");
		expect(items.map((item) => item.entityId)).toEqual(["e-old"]);
	});

	it("honours since", async () => {
		const items = await touched("who=Matt%20West&since=2026-07-01T00:00:00.000Z");
		expect(items.map((item) => item.entityId)).toEqual(["e-new"]);
	});
});
