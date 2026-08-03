import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	getPrincipalIdentity,
	listPrincipalIdentifiers,
	organizationFromEmailDomain,
	principalDeclarationsFromAccounts,
	principalOrganizationFor,
	setPrincipalIdentity,
} from "./principal-identity";

describe("organizationFromEmailDomain", () => {
	it("takes the registrable label from a real domain", () => {
		expect(organizationFromEmailDomain("njui@pivotplanit.com")).toBe("pivotplanit");
		expect(organizationFromEmailDomain("kinyanjui@kuze.ai")).toBe("kuze");
		expect(organizationFromEmailDomain("matt@mail.dock-blocks.com")).toBe("dock-blocks");
	});

	it("looks past a two-part public suffix", () => {
		expect(organizationFromEmailDomain("someone@acme.co.uk")).toBe("acme");
		expect(organizationFromEmailDomain("someone@acme.com.au")).toBe("acme");
	});

	it("returns null for a consumer mailbox rather than inventing a shared org", () => {
		// Everyone with a gmail address would otherwise become a member of "google".
		expect(organizationFromEmailDomain("nyashkn@gmail.com")).toBeNull();
		expect(organizationFromEmailDomain("someone@icloud.com")).toBeNull();
		expect(organizationFromEmailDomain("not-an-address")).toBeNull();
	});
});

describe("principalDeclarationsFromAccounts", () => {
	it("declares one email handle per account, org-scoped by domain", () => {
		const declarations = principalDeclarationsFromAccounts([
			{ name: "pivotplanit", address: "njui@pivotplanit.com" },
			{ name: "kuze", address: "kinyanjui@kuze.ai" },
			{ name: "gmail", address: "nyashkn@gmail.com" },
		]);
		expect(declarations).toEqual([
			{
				identifier: "njui@pivotplanit.com",
				kind: "email",
				organization: "pivotplanit",
				source: "himalaya-account:pivotplanit",
			},
			{ identifier: "kinyanjui@kuze.ai", kind: "email", organization: "kuze", source: "himalaya-account:kuze" },
			{ identifier: "nyashkn@gmail.com", kind: "email", source: "himalaya-account:gmail" },
		]);
	});

	it("skips an account whose address could not be read instead of guessing one", () => {
		// OAuth2 accounts have no SASL username to read.
		expect(principalDeclarationsFromAccounts([{ name: "oauth-account", address: null }])).toEqual([]);
	});
});

describe("principal identity storage", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-principal-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function rows<T>(sql: string, ...args: unknown[]): T[] {
		return getDbAccessor().withReadDb((db) => db.prepare(sql).all(...args)) as T[];
	}

	function declare(): ReturnType<typeof setPrincipalIdentity> {
		return setPrincipalIdentity({
			agentId: "default",
			displayName: "KN",
			identities: principalDeclarationsFromAccounts([
				{ name: "pivotplanit", address: "njui@pivotplanit.com" },
				{ name: "kuze", address: "kinyanjui@kuze.ai" },
				{ name: "gmail", address: "nyashkn@gmail.com" },
			]),
		});
	}

	it("records the operator on the agent row and every handle as a typed alias", () => {
		const result = declare();
		expect(result?.displayName).toBe("KN");
		expect(result?.aliasesWritten).toBe(3);

		const agent = rows<{ principal_entity_id: string | null }>(
			"SELECT principal_entity_id FROM agents WHERE id = 'default'",
		);
		expect(agent[0]?.principal_entity_id).toBe(result?.entityId ?? "");

		const aliases = rows<{ canonical_alias: string; alias_kind: string; confidence: number; source: string }>(
			"SELECT canonical_alias, alias_kind, confidence, source FROM entity_aliases WHERE status = 'active' ORDER BY canonical_alias",
		);
		expect(aliases.map((row) => row.canonical_alias)).toEqual([
			"kinyanjui@kuze.ai",
			"njui@pivotplanit.com",
			"nyashkn@gmail.com",
		]);
		// User-asserted, so it applies at full confidence rather than queueing.
		expect(aliases.every((row) => row.alias_kind === "email" && row.confidence === 1)).toBe(true);
		expect(aliases[1]?.source).toBe("himalaya-account:pivotplanit");
	});

	it("scopes work handles to an organization and leaves the personal one unscoped", () => {
		declare();
		const identity = getPrincipalIdentity("default");
		const byIdentifier = new Map(identity?.handles.map((handle) => [handle.identifier, handle.organization]));
		expect(byIdentifier.get("njui@pivotplanit.com")).toBe("pivotplanit");
		expect(byIdentifier.get("kinyanjui@kuze.ai")).toBe("kuze");
		expect(byIdentifier.get("nyashkn@gmail.com")).toBeNull();

		expect(principalOrganizationFor("default", "NJUI@PivotPlanIt.com")?.name).toBe("pivotplanit");
		expect(principalOrganizationFor("default", "nyashkn@gmail.com")).toBeNull();

		const orgs = rows<{ name: string }>("SELECT name FROM entities WHERE entity_type = 'organization' ORDER BY name");
		expect(orgs.map((row) => row.name)).toEqual(["kuze", "pivotplanit"]);
	});

	it("reports an address already minted as its own person instead of deleting it", () => {
		// This is what the first live email ingest produced: njui@pivotplanit.com
		// became an ordinary person with 52 mentions. Merging is destructive, so it
		// belongs in the proposal queue — the alias alone already makes lookups
		// resolve to the principal.
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('ent_existing', 'njui@pivotplanit.com', 'njui@pivotplanit.com', 'person', 'default', 52,
				         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			).run();
		});

		const result = declare();
		expect(result?.mergeCandidates).toEqual(["ent_existing"]);
		expect(result?.entityId).not.toBe("ent_existing");

		const survivor = rows<{ n: number }>("SELECT COUNT(*) AS n FROM entities WHERE id = 'ent_existing'");
		expect(survivor[0]?.n).toBe(1);

		const alias = rows<{ entity_id: string }>(
			"SELECT entity_id FROM entity_aliases WHERE canonical_alias = 'njui@pivotplanit.com' AND status = 'active'",
		);
		expect(alias[0]?.entity_id).toBe(result?.entityId ?? "");
	});

	it("is idempotent — re-declaring updates in place rather than duplicating", () => {
		const first = declare();
		const second = declare();
		expect(second?.entityId).toBe(first?.entityId ?? "");
		expect(second?.aliasesWritten).toBe(0);

		const counts = rows<{ n: number }>("SELECT COUNT(*) AS n FROM entity_aliases WHERE status = 'active'");
		expect(counts[0]?.n).toBe(3);
		const orgCount = rows<{ n: number }>("SELECT COUNT(*) AS n FROM entities WHERE entity_type = 'organization'");
		expect(orgCount[0]?.n).toBe(2);
	});

	it("returns an empty identifier set when no principal is declared, so callers can fall back", () => {
		expect(getPrincipalIdentity("default")).toBeNull();
		expect(listPrincipalIdentifiers("default", "email").size).toBe(0);

		declare();
		expect([...listPrincipalIdentifiers("default", "email")].sort()).toEqual([
			"kinyanjui@kuze.ai",
			"njui@pivotplanit.com",
			"nyashkn@gmail.com",
		]);
		expect(listPrincipalIdentifiers("default", "github_login").size).toBe(0);
	});
});
