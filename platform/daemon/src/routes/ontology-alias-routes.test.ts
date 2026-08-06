import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { registerOntologyRoutes } from "./ontology-routes";
import { reloadAuthState, resetAuthStateForTests } from "./state";

/**
 * The alias route is the only write surface identity has, so its rejections are
 * as load-bearing as its successes: a bad `alias_kind` that silently persists
 * makes "record a phone as a phone" unverifiable, and a bare "alias already
 * exists" leaves the caller with no next move.
 */
describe("POST /api/ontology/entities/:id/aliases", () => {
	let dir = "";
	let app: Hono;
	let authDir = "";

	/**
	 * Reproduce, in-file, the state another suite leaves behind.
	 *
	 * `authConfig` is a module-global and `bun test` runs every file in one
	 * process, so `daemon-auth-guard-colocation.test.ts` switching to team mode
	 * makes every later file authenticate against a config it never chose. These
	 * four tests passed alone and returned 403 in the full suite for exactly that
	 * reason. Poisoning here rather than depending on file order means the guard
	 * is tested, not the run order: without the `beforeEach` reset below, every
	 * assertion in this file fails with 403.
	 */
	beforeAll(() => {
		authDir = mkdtempSync(join(tmpdir(), "signet-alias-auth-"));
		mkdirSync(join(authDir, ".daemon"), { recursive: true });
		writeFileSync(join(authDir, ".daemon", "auth-secret"), "test-secret-key-32-bytes-min!!");
		writeFileSync(
			join(authDir, "agent.yaml"),
			`auth:
  mode: team
  rateLimits:
    forget:
      windowMs: 60000
      max: 30
    modify:
      windowMs: 60000
      max: 60
`,
		);
		reloadAuthState(authDir);
	});

	afterAll(() => {
		resetAuthStateForTests();
		rmSync(authDir, { recursive: true, force: true });
	});

	function seedEntity(id: string, name: string, entityType = "person"): void {
		const ts = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'default', 0, ?, ?)`,
			).run(id, name, name.toLowerCase(), entityType, ts, ts);
		});
	}

	async function post(entityId: string, body: Record<string, unknown>): Promise<Response> {
		return app.request(`/api/ontology/entities/${entityId}/aliases`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	beforeEach(() => {
		// The identity routes are what is under test, not the auth mode they
		// happen to inherit.
		resetAuthStateForTests();
		dir = mkdtempSync(join(tmpdir(), "signet-alias-routes-"));
		closeDbAccessor();
		initDbAccessor(join(dir, "memories.db"));
		app = new Hono();
		registerOntologyRoutes(app);
		seedEntity("e-matt", "Matt West");
		seedEntity("e-org", "Dock Blocks", "organization");
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("stores a typed handle and returns its kind", async () => {
		const res = await post("e-matt", { alias: "+1 555 0100", alias_kind: "phone", org_entity_id: "e-org" });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { item: { aliasKind: string | null; orgEntityId: string | null } };
		expect(body.item.aliasKind).toBe("phone");
		expect(body.item.orgEntityId).toBe("e-org");

		const listed = (await (await app.request("/api/ontology/entities/e-matt/aliases")).json()) as {
			items: Array<{ aliasKind: string | null }>;
		};
		expect(listed.items.map((item) => item.aliasKind)).toEqual(["phone"]);
	});

	it("rejects a kind outside the handle vocabulary", async () => {
		const res = await post("e-matt", { alias: "matt", alias_kind: "mobile" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("phone");
	});

	it("rejects an organization that does not exist", async () => {
		const res = await post("e-matt", { alias: "matt@dock-blocks.com", org_entity_id: "e-missing" });
		expect(res.status).toBe(404);
	});

	it("names the current holder when a handle is already claimed", async () => {
		expect((await post("e-matt", { alias: "Matt", alias_kind: "display_name" })).status).toBe(201);

		seedEntity("e-other", "Matthew Green");
		const res = await post("e-other", { alias: "matt", alias_kind: "display_name" });
		expect(res.status).toBe(409);
		// One handle resolves to one entity per agent (migration 077). The caller
		// has to unlink it from Matt West first, so the message has to say so.
		const error = ((await res.json()) as { error: string }).error;
		expect(error).toContain("Matt West");
		expect(error).toContain("e-matt");
	});
});
