/**
 * The principal — the human operating this agent — and their org-scoped handles.
 *
 * Nothing in Signet modelled the operator before this. `identity.ts` in
 * `@signet/core` is about the *agent's* persona files, not the person running
 * it, so the email connector had to infer its own account's addresses by
 * counting how often each one appeared in a `To:` header. That works on a busy
 * mailbox and fails silently on a quiet or freshly-connected one.
 *
 * The model is one principal with many context-scoped identities:
 *
 *     principal: KN
 *       ├─ njui@pivotplanit.com   kind: email   org: PivotPlanIt
 *       ├─ kinyanjui@kuze.ai      kind: email   org: Kuze
 *       └─ nyashkn@gmail.com      kind: email   org: —
 *
 * The organization pairing is the part that did not exist anywhere. An alias
 * asserts only "same person"; pairing it with an organization says *which hat
 * that person was wearing*, which is what makes a trail readable — "what did we
 * send Matt" means as PivotPlanIt, not as Kuze.
 *
 * Writes follow the apply-first-with-audit doctrine: declared identities are
 * user-asserted, so their alias rows apply directly at confidence 1.0. Where a
 * declared handle already exists as its own entity — `njui@pivotplanit.com` was
 * minted as an ordinary person by the first live ingest — that entity is left
 * alone and reported as a merge candidate. Collapsing two entities is
 * destructive, so it belongs in the pending proposal queue, not here.
 */

import { createHash } from "node:crypto";
import type { ReadDb, WriteDb } from "./db-accessor";
import { getDbAccessor } from "./db-accessor";

/**
 * Handle vocabulary for `entity_aliases.alias_kind`.
 *
 * Kept as a local union for the same reason the participant edge types are: the
 * shared enums in `@signet/core` are fed to the extraction prompt, and the
 * column is plain TEXT either way.
 */
export type AliasKind = "email" | "github_login" | "clickup_member" | "discord_id" | "phone" | "display_name";

export const ALIAS_KINDS: readonly AliasKind[] = [
	"email",
	"github_login",
	"clickup_member",
	"discord_id",
	"phone",
	"display_name",
];

export function isAliasKind(value: string): value is AliasKind {
	return (ALIAS_KINDS as readonly string[]).includes(value);
}

export interface PrincipalIdentityDeclaration {
	/** The handle itself — an email address, a GitHub login, a phone number. */
	readonly identifier: string;
	readonly kind: AliasKind;
	/** Display name of the organization this handle belongs to. Omit for personal handles. */
	readonly organization?: string;
	/** Where the declaration came from, stored on the alias row for audit. */
	readonly source?: string;
}

export interface SetPrincipalIdentityInput {
	readonly agentId: string;
	/** Canonical display name for the operator — "KN". */
	readonly displayName: string;
	readonly identities: readonly PrincipalIdentityDeclaration[];
}

export interface PrincipalHandle {
	readonly identifier: string;
	readonly kind: AliasKind | null;
	readonly organizationId: string | null;
	readonly organization: string | null;
}

export interface PrincipalIdentity {
	readonly entityId: string;
	readonly displayName: string;
	readonly handles: readonly PrincipalHandle[];
}

export interface SetPrincipalIdentityResult extends PrincipalIdentity {
	readonly aliasesWritten: number;
	readonly organizationsCreated: number;
	/**
	 * Entities that already own a declared handle as their own canonical name.
	 * Each is a genuine duplicate of the principal, but merging deletes a row, so
	 * these are handed to P4's proposal queue rather than actioned here.
	 */
	readonly mergeCandidates: readonly string[];
}

function idFor(prefix: string, ...parts: readonly string[]): string {
	return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

/** Mirrors `toCanonicalName` in the extraction pipeline so both populations land on one row. */
function toCanonicalName(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function upsertEntity(
	db: WriteDb,
	agentId: string,
	name: string,
	entityType: string,
	now: string,
): { readonly id: string; readonly created: boolean } | null {
	const canonical = toCanonicalName(name);
	if (canonical.length === 0) return null;

	const existing = db
		.prepare("SELECT id FROM entities WHERE canonical_name = ? AND agent_id = ? LIMIT 1")
		.get(canonical, agentId) as { id: string } | undefined;
	if (existing) return { id: existing.id, created: false };

	const id = idFor("idn", agentId, entityType, canonical);
	try {
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
		).run(id, name.trim(), canonical, entityType, agentId, now, now);
		return { id, created: true };
	} catch (err) {
		// `entities.name` is UNIQUE across every agent, so a name already used by an
		// LLM-extracted entity collides. Adopting that row is correct — it is the
		// same organization or person — rather than inventing a suffixed duplicate.
		const message = err instanceof Error ? err.message : String(err);
		if (!message.includes("UNIQUE constraint")) throw err;
		const fallback = db.prepare("SELECT id FROM entities WHERE name = ? LIMIT 1").get(name.trim()) as
			| { id: string }
			| undefined;
		return fallback ? { id: fallback.id, created: false } : null;
	}
}

/**
 * Picks the entity that will represent the principal.
 *
 * Preference order matters: an entity already named for the operator is a
 * better anchor than one named for a single address, because it is the one the
 * extraction pipeline has been accumulating mentions against.
 */
function resolvePrincipalEntity(
	db: WriteDb,
	input: SetPrincipalIdentityInput,
	now: string,
): { readonly id: string; readonly created: boolean } | null {
	const declared = db.prepare("SELECT principal_entity_id FROM agents WHERE id = ? LIMIT 1").get(input.agentId) as
		| { principal_entity_id: string | null }
		| undefined;
	if (declared?.principal_entity_id) {
		const stillExists = db.prepare("SELECT id FROM entities WHERE id = ? LIMIT 1").get(declared.principal_entity_id) as
			| { id: string }
			| undefined;
		if (stillExists) return { id: stillExists.id, created: false };
	}
	return upsertEntity(db, input.agentId, input.displayName, "person", now);
}

function upsertAlias(
	db: WriteDb,
	agentId: string,
	entityId: string,
	declaration: PrincipalIdentityDeclaration,
	organizationId: string | null,
	now: string,
): boolean {
	const canonical = toCanonicalName(declaration.identifier);
	if (canonical.length === 0) return false;
	const source = declaration.source ?? "principal-declaration";

	const existing = db
		.prepare("SELECT id FROM entity_aliases WHERE agent_id = ? AND canonical_alias = ? AND status = 'active' LIMIT 1")
		.get(agentId, canonical) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE entity_aliases
			 SET entity_id = ?, alias = ?, alias_kind = ?, org_entity_id = ?, confidence = 1.0,
			     source = ?, updated_at = ?
			 WHERE id = ?`,
		).run(entityId, declaration.identifier.trim(), declaration.kind, organizationId, source, now, existing.id);
		return false;
	}

	db.prepare(
		`INSERT INTO entity_aliases
		 (id, entity_id, agent_id, alias, canonical_alias, alias_kind, org_entity_id, confidence, source,
		  status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, 'active', ?, ?)`,
	).run(
		idFor("alias", agentId, canonical),
		entityId,
		agentId,
		declaration.identifier.trim(),
		canonical,
		declaration.kind,
		organizationId,
		source,
		now,
		now,
	);
	return true;
}

export function setPrincipalIdentityInTx(
	db: WriteDb,
	input: SetPrincipalIdentityInput,
	now = new Date().toISOString(),
): SetPrincipalIdentityResult | null {
	const principal = resolvePrincipalEntity(db, input, now);
	if (!principal) return null;

	let aliasesWritten = 0;
	let organizationsCreated = 0;
	const mergeCandidates = new Set<string>();
	const organizationIds = new Map<string, string>();

	for (const declaration of input.identities) {
		const canonical = toCanonicalName(declaration.identifier);
		if (canonical.length === 0) continue;

		let organizationId: string | null = null;
		const organization = declaration.organization?.trim();
		if (organization && organization.length > 0) {
			const cached = organizationIds.get(toCanonicalName(organization));
			if (cached) organizationId = cached;
			else {
				const org = upsertEntity(db, input.agentId, organization, "organization", now);
				if (org) {
					organizationId = org.id;
					organizationIds.set(toCanonicalName(organization), org.id);
					if (org.created) organizationsCreated++;
				}
			}
		}

		if (upsertAlias(db, input.agentId, principal.id, declaration, organizationId, now)) aliasesWritten++;

		// A handle the connector already minted as its own person is the same human
		// wearing one hat. The alias above makes lookups resolve correctly straight
		// away; collapsing the rows is destructive and goes to the proposal queue.
		const duplicate = db
			.prepare("SELECT id FROM entities WHERE canonical_name = ? AND agent_id = ? AND id != ? LIMIT 1")
			.get(canonical, input.agentId, principal.id) as { id: string } | undefined;
		if (duplicate) mergeCandidates.add(duplicate.id);
	}

	db.prepare(
		`INSERT INTO agents (id, name, read_policy, created_at, updated_at)
		 VALUES (?, ?, 'isolated', ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
	).run(input.agentId, input.agentId, now, now);
	db.prepare("UPDATE agents SET principal_entity_id = ?, updated_at = ? WHERE id = ?").run(
		principal.id,
		now,
		input.agentId,
	);

	const identity = readPrincipalIdentity(db, input.agentId);
	if (!identity) return null;
	return { ...identity, aliasesWritten, organizationsCreated, mergeCandidates: [...mergeCandidates] };
}

export function setPrincipalIdentity(input: SetPrincipalIdentityInput): SetPrincipalIdentityResult | null {
	const now = new Date().toISOString();
	return getDbAccessor().withWriteTx((db) => setPrincipalIdentityInTx(db, input, now));
}

interface AliasRow {
	readonly alias: string;
	readonly alias_kind: string | null;
	readonly org_entity_id: string | null;
	readonly org_name: string | null;
}

function readPrincipalIdentity(db: ReadDb, agentId: string): PrincipalIdentity | null {
	const agent = db.prepare("SELECT principal_entity_id FROM agents WHERE id = ? LIMIT 1").get(agentId) as
		| { principal_entity_id: string | null }
		| undefined;
	const entityId = agent?.principal_entity_id;
	if (!entityId) return null;

	const entity = db.prepare("SELECT name FROM entities WHERE id = ? LIMIT 1").get(entityId) as
		| { name: string }
		| undefined;
	if (!entity) return null;

	const rows = db
		.prepare(
			`SELECT a.alias, a.alias_kind, a.org_entity_id, o.name AS org_name
			 FROM entity_aliases a
			 LEFT JOIN entities o ON o.id = a.org_entity_id
			 WHERE a.agent_id = ? AND a.entity_id = ? AND a.status = 'active'
			 ORDER BY a.alias_kind, a.canonical_alias`,
		)
		.all(agentId, entityId) as AliasRow[];

	return {
		entityId,
		displayName: entity.name,
		handles: rows.map((row) => ({
			identifier: row.alias,
			kind: row.alias_kind && isAliasKind(row.alias_kind) ? row.alias_kind : null,
			organizationId: row.org_entity_id,
			organization: row.org_name,
		})),
	};
}

export function getPrincipalIdentity(agentId: string): PrincipalIdentity | null {
	try {
		return getDbAccessor().withReadDb((db) => readPrincipalIdentity(db, agentId));
	} catch {
		return null;
	}
}

export function getPrincipalEntityId(agentId: string): string | null {
	return getPrincipalIdentity(agentId)?.entityId ?? null;
}

/**
 * Every handle of the given kind belonging to the operator.
 *
 * This is what replaces `collectOwnAddresses`' frequency heuristic in the email
 * connector. Returns an empty set when no principal has been declared, so the
 * caller can fall back rather than silently treating every correspondent as
 * self.
 */
export function listPrincipalIdentifiers(agentId: string, kind: AliasKind): ReadonlySet<string> {
	const identity = getPrincipalIdentity(agentId);
	if (!identity) return new Set<string>();
	return new Set(
		identity.handles.filter((handle) => handle.kind === kind).map((handle) => toCanonicalName(handle.identifier)),
	);
}

/**
 * Mail domains that identify a consumer mailbox rather than an organization.
 *
 * Deriving an org from `gmail.com` would invent an entity that every unrelated
 * person also belongs to, which is worse than leaving the handle unscoped.
 */
const CONSUMER_MAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"ymail.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"icloud.com",
	"me.com",
	"proton.me",
	"protonmail.com",
	"aol.com",
	"gmx.com",
	"fastmail.com",
]);

/** Labels that are part of a public suffix rather than a registrable name when they sit under a country TLD. */
const GENERIC_SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ltd", "plc", "or", "go"]);

/**
 * Organization implied by an email address, or null when it implies none.
 *
 * The registrable label is used rather than the full domain because it is what a
 * human would type — "kuze", not "kuze.ai". Correct display casing is not
 * recoverable from a domain, so the entity is created lowercase and renaming it
 * is a normal graph edit.
 */
export function organizationFromEmailDomain(address: string): string | null {
	const domain = address.split("@")[1]?.trim().toLowerCase() ?? "";
	if (domain.length === 0 || CONSUMER_MAIL_DOMAINS.has(domain)) return null;
	const labels = domain.split(".").filter((label) => label.length > 0);
	if (labels.length < 2) return null;
	// Two-part public suffixes (`co.uk`, `com.au`) put the registrable label one
	// position further left than a plain `.com` does. Recognised by shape — a
	// generic label under a two-letter country code — rather than by table.
	// ponytail: covers the common cases; a real public-suffix list is a dependency
	// and a download, worth adding only if a miss ever matters.
	const tld = labels[labels.length - 1] ?? "";
	const secondLevel = labels[labels.length - 2] ?? "";
	const isTwoPartSuffix = labels.length >= 3 && tld.length === 2 && GENERIC_SECOND_LEVEL.has(secondLevel);
	return labels[labels.length - (isTwoPartSuffix ? 3 : 2)] ?? null;
}

export interface MailAccountSeed {
	readonly name: string;
	readonly address: string | null;
}

/**
 * Turns configured mail accounts into principal declarations.
 *
 * Pure on purpose — the himalaya call lives in the connector, so declaring a
 * principal never depends on email being the source of the handles. Accounts
 * whose address could not be read contribute nothing rather than a guess.
 */
export function principalDeclarationsFromAccounts(
	accounts: readonly MailAccountSeed[],
): readonly PrincipalIdentityDeclaration[] {
	const declarations: PrincipalIdentityDeclaration[] = [];
	for (const account of accounts) {
		const address = account.address?.trim().toLowerCase();
		if (!address || address.length === 0 || !address.includes("@")) continue;
		const organization = organizationFromEmailDomain(address);
		declarations.push({
			identifier: address,
			kind: "email",
			...(organization ? { organization } : {}),
			source: `himalaya-account:${account.name}`,
		});
	}
	return declarations;
}

/** Which organization hat the operator was wearing when they used this handle. */
export function principalOrganizationFor(
	agentId: string,
	identifier: string,
): { readonly entityId: string; readonly name: string } | null {
	const identity = getPrincipalIdentity(agentId);
	if (!identity) return null;
	const canonical = toCanonicalName(identifier);
	const handle = identity.handles.find((candidate) => toCanonicalName(candidate.identifier) === canonical);
	if (!handle?.organizationId || !handle.organization) return null;
	return { entityId: handle.organizationId, name: handle.organization };
}
