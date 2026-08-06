/**
 * People edges for source artifacts.
 *
 * `indexSourceArtifactStructure` builds the *containment* tree — source holds
 * document holds aspects. It says nothing about who wrote or received a thing,
 * which is why `authored_by` has never had a single row despite being a legal
 * dependency type since the graph was introduced.
 *
 * This module supplies the missing half: given participants asserted by an
 * artifact's own metadata (RFC 5322 headers today; ClickUp assignees and GitHub
 * authors on the same seam later), mint person entities and typed edges from
 * the artifact to them.
 *
 * Two rules make it safe to run against a graph that already has 273 people in
 * it from LLM extraction:
 *
 * 1. **Identity is keyed on the identifier, not the display name.** One real
 *    address arrives as `Dock Blocks`, `matt dock-blocks.com` and `Matt` in the
 *    same forwarded thread; keying on the address collapses those, keying on
 *    the name would invent three people.
 * 2. **An existing entity is never retyped.** If an address is already in the
 *    graph as an `artifact`, the edge is still written but the type change is
 *    left to the ontology proposal loop, where it is auditable and reversible.
 */

import { createHash } from "node:crypto";
import type { WriteDb } from "./db-accessor";
import { getDbAccessor } from "./db-accessor";

/**
 * Connector-local edge vocabulary.
 *
 * Deliberately not added to `DEPENDENCY_TYPES`: that array is fed verbatim into
 * the LLM extraction prompt (`structural-dependency.ts`), so widening it would
 * change extraction behaviour in a PR that is meant to add a connector. The
 * column is plain TEXT, so these persist and query fine; promoting them into
 * the shared enum is a separate, honest one-line change.
 */
export type ParticipantEdgeType = "authored_by" | "addressed_to" | "copied_on" | "replies_to" | "forwards";

export interface SourceParticipant {
	/** Stable identifier — an email address, GitHub login, ClickUp member id. Lowercased by the caller. */
	readonly identifier: string;
	/** Display name as asserted by the source. Optional; the identifier is used when absent. */
	readonly displayName?: string;
	readonly edgeType: ParticipantEdgeType;
	/**
	 * 1 for a participant asserted by an envelope header, lower for one recovered
	 * from a quoted forward block where the quoting client is the only witness.
	 */
	readonly strength: number;
	/** Human-readable provenance stored on the edge, per the migration 036 vocabulary. */
	readonly reason: string;
}

export interface IndexSourceParticipantsInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceKind: string;
	readonly sourceRoot: string;
	readonly sourcePath: string;
	/** Entity id of the artifact the participants relate to — `documentEntityId` from `indexSourceArtifactStructure`. */
	readonly documentEntityId: string;
	readonly participants: readonly SourceParticipant[];
}

export interface IndexSourceParticipantsResult {
	readonly personsCreated: number;
	readonly personsLinked: number;
	readonly edgesWritten: number;
	/** Display-name aliases written for address-keyed people. */
	readonly aliasesWritten: number;
	/** Identifiers already present under a non-person type; candidates for a retype proposal in P4. */
	readonly typeConflicts: readonly string[];
}

/**
 * Entity types a personal display name may legitimately name.
 *
 * `Dock Blocks <matt@dock-blocks.com>` is the company signing the mail, not the
 * human sending it. Writing that alias would make every later lookup of the
 * organization resolve to Matt, so a display name colliding with anything that
 * is not already a person (or an address minted as an `artifact`) is dropped.
 */
const ALIASABLE_ENTITY_TYPES = new Set(["person", "artifact"]);

function idFor(...parts: readonly string[]): string {
	return `src_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

/** Mirrors `toCanonicalName` in the extraction pipeline so both populations land on one row. */
function toCanonicalName(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

interface ResolvedPerson {
	readonly id: string;
	readonly created: boolean;
	readonly typeConflict: boolean;
}

function upsertPerson(
	db: WriteDb,
	input: IndexSourceParticipantsInput,
	participant: SourceParticipant,
	now: string,
): ResolvedPerson | null {
	const canonical = toCanonicalName(participant.identifier);
	if (canonical.length === 0) return null;
	const displayName = participant.displayName?.trim();
	const name = displayName && displayName.length > 0 ? displayName : participant.identifier;

	const existing = db
		.prepare("SELECT id, entity_type FROM entities WHERE canonical_name = ? AND agent_id = ? LIMIT 1")
		.get(canonical, input.agentId) as { id: string; entity_type: string } | undefined;
	if (existing) {
		db.prepare("UPDATE entities SET mentions = COALESCE(mentions, 0) + 1, updated_at = ? WHERE id = ?").run(
			now,
			existing.id,
		);
		return { id: existing.id, created: false, typeConflict: existing.entity_type !== "person" };
	}

	// A spelling already held as another entity's active alias belongs to that
	// entity. Without this the next sync re-mints the row someone deliberately
	// linked away — `Jui` comes back as its own person and starts accreting
	// edges again, so the link has to be redone after every sync forever.
	//
	// Checked after the exact-canonical match, not before: an entity that owns
	// the name outright is a stronger claim than one that merely answers to it.
	const aliasHolder = db
		.prepare(
			`SELECT e.id, e.entity_type FROM entity_aliases a
			 JOIN entities e ON e.id = a.entity_id AND e.agent_id = a.agent_id
			 WHERE a.agent_id = ? AND a.canonical_alias = ? AND a.status = 'active'
			   AND COALESCE(e.status, 'active') = 'active'
			 LIMIT 1`,
		)
		.get(input.agentId, canonical) as { id: string; entity_type: string } | undefined;
	if (aliasHolder) {
		db.prepare("UPDATE entities SET mentions = COALESCE(mentions, 0) + 1, updated_at = ? WHERE id = ?").run(
			now,
			aliasHolder.id,
		);
		return { id: aliasHolder.id, created: false, typeConflict: aliasHolder.entity_type !== "person" };
	}

	const id = idFor(input.agentId, "person", canonical);
	try {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at,
			  source_id, source_kind, source_path, source_root)
			 VALUES (?, ?, ?, 'person', ?, 1, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			name,
			canonical,
			input.agentId,
			now,
			now,
			input.sourceId,
			input.sourceKind,
			input.sourcePath,
			input.sourceRoot,
		);
		return { id, created: true, typeConflict: false };
	} catch (err) {
		// `entities.name` is UNIQUE across every agent, so a display name already
		// used by an LLM-extracted entity collides here. Reusing that row is the
		// correct outcome — it is the same person — so adopt it rather than
		// inventing a suffixed duplicate.
		const message = err instanceof Error ? err.message : String(err);
		if (!message.includes("UNIQUE constraint")) throw err;
		const fallback = db.prepare("SELECT id, entity_type FROM entities WHERE name = ? LIMIT 1").get(name) as
			| { id: string; entity_type: string }
			| undefined;
		if (!fallback) return null;
		db.prepare(
			`UPDATE entities
			 SET mentions = COALESCE(mentions, 0) + 1, updated_at = ?, canonical_name = COALESCE(canonical_name, ?)
			 WHERE id = ?`,
		).run(now, canonical, fallback.id);
		return { id: fallback.id, created: false, typeConflict: fallback.entity_type !== "person" };
	}
}

/**
 * Record the name↔address pairing an RFC 5322 header asserts.
 *
 * This is the cheapest identity evidence that exists: `From: Matt West
 * <matt@dock-blocks.com>` states, at transport level, that the display name and
 * the address are the same human. Person entities are keyed on the address, so
 * without this the graph keeps `Matt West` (from LLM extraction) and
 * `matt@dock-blocks.com` (from this connector) as unrelated rows that differ in
 * both name and type — which the exact-canonical duplicate check can never see.
 *
 * The alias applies directly at the participant's own strength (1.0 for an
 * envelope header, lower for a quoted forward block), per the apply-first
 * doctrine: an alias is additive and archivable, unlike a merge.
 */
function upsertDisplayNameAlias(
	db: WriteDb,
	input: IndexSourceParticipantsInput,
	participant: SourceParticipant,
	personEntityId: string,
	now: string,
): boolean {
	const displayName = participant.displayName?.trim() ?? "";
	const canonical = toCanonicalName(displayName);
	// A two-character name is a parse artifact, not a person: the live corpus
	// produced `is` from a quoted `Cc:` fragment, which would then claim every
	// later mention of that word as an identity.
	if (canonical.length < 3 || canonical === toCanonicalName(participant.identifier)) return false;

	const collision = db
		.prepare("SELECT entity_type FROM entities WHERE canonical_name = ? AND agent_id = ? LIMIT 1")
		.get(canonical, input.agentId) as { entity_type: string } | undefined;
	if (collision && !ALIASABLE_ENTITY_TYPES.has(collision.entity_type)) return false;

	// One handle resolves to one entity (migration 077's unique index). A header
	// never outranks an existing claim — the principal declaration and an earlier
	// message both got here first on purpose — so a taken alias is left alone and
	// surfaces as a merge candidate instead.
	const taken = db
		.prepare("SELECT id FROM entity_aliases WHERE agent_id = ? AND canonical_alias = ? AND status = 'active' LIMIT 1")
		.get(input.agentId, canonical) as { id: string } | undefined;
	if (taken) return false;

	db.prepare(
		`INSERT INTO entity_aliases
		 (id, entity_id, agent_id, alias, canonical_alias, alias_kind, confidence, source,
		  status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'display_name', ?, ?, 'active', ?, ?)`,
	).run(
		idFor("alias", input.agentId, canonical),
		personEntityId,
		input.agentId,
		displayName,
		canonical,
		Math.min(1, Math.max(0, participant.strength)),
		participant.reason,
		now,
		now,
	);
	return true;
}

function upsertParticipantEdge(
	db: WriteDb,
	input: IndexSourceParticipantsInput,
	participant: SourceParticipant,
	personEntityId: string,
	now: string,
): boolean {
	const strength = Math.min(1, Math.max(0, participant.strength));
	const existing = db
		.prepare(
			`SELECT id FROM entity_dependencies
			 WHERE source_entity_id = ? AND target_entity_id = ? AND dependency_type = ? AND agent_id = ?
			 LIMIT 1`,
		)
		.get(input.documentEntityId, personEntityId, participant.edgeType, input.agentId) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE entity_dependencies
			 SET strength = MAX(strength, ?), confidence = MAX(COALESCE(confidence, 0), ?),
			     reason = ?, updated_at = ?, source_id = ?, source_kind = ?, source_path = ?, source_root = ?
			 WHERE id = ?`,
		).run(
			strength,
			strength,
			participant.reason,
			now,
			input.sourceId,
			input.sourceKind,
			input.sourcePath,
			input.sourceRoot,
			existing.id,
		);
		return false;
	}
	db.prepare(
		`INSERT INTO entity_dependencies
		 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason,
		  created_at, updated_at, source_id, source_kind, source_path, source_root)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		idFor("dep", input.agentId, participant.edgeType, input.documentEntityId, personEntityId),
		input.documentEntityId,
		personEntityId,
		input.agentId,
		participant.edgeType,
		strength,
		strength,
		participant.reason,
		now,
		now,
		input.sourceId,
		input.sourceKind,
		input.sourcePath,
		input.sourceRoot,
	);
	return true;
}

export function indexSourceParticipantsInTx(
	db: WriteDb,
	input: IndexSourceParticipantsInput,
	now = new Date().toISOString(),
): IndexSourceParticipantsResult {
	// Containment rebuilds wipe this artifact's edges, so start from a clean
	// slate for the participant types too rather than leaving orphans behind
	// when a recipient is removed from a re-synced message.
	db.prepare(
		`DELETE FROM entity_dependencies
		 WHERE agent_id = ? AND source_id = ? AND source_path = ?
		   AND dependency_type IN ('authored_by', 'addressed_to', 'copied_on', 'replies_to', 'forwards')`,
	).run(input.agentId, input.sourceId, input.sourcePath);

	let personsCreated = 0;
	let personsLinked = 0;
	let edgesWritten = 0;
	let aliasesWritten = 0;
	const typeConflicts = new Set<string>();

	for (const participant of input.participants) {
		const person = upsertPerson(db, input, participant, now);
		if (!person) continue;
		if (person.created) personsCreated++;
		else personsLinked++;
		if (person.typeConflict) typeConflicts.add(participant.identifier);
		if (upsertParticipantEdge(db, input, participant, person.id, now)) edgesWritten++;
		if (upsertDisplayNameAlias(db, input, participant, person.id, now)) aliasesWritten++;
	}

	return { personsCreated, personsLinked, edgesWritten, aliasesWritten, typeConflicts: [...typeConflicts] };
}

export function indexSourceParticipants(input: IndexSourceParticipantsInput): IndexSourceParticipantsResult {
	const now = new Date().toISOString();
	return getDbAccessor().withWriteTx((db) => indexSourceParticipantsInTx(db, input, now));
}

/** Edge between two artifacts — thread reply chains and forwarded originals. */
export interface IndexArtifactRelationInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceKind: string;
	readonly sourceRoot: string;
	readonly sourcePath: string;
	readonly fromEntityId: string;
	readonly toEntityId: string;
	readonly edgeType: ParticipantEdgeType;
	readonly strength: number;
	readonly reason: string;
}

export function indexArtifactRelationInTx(
	db: WriteDb,
	input: IndexArtifactRelationInput,
	now = new Date().toISOString(),
): boolean {
	return upsertParticipantEdge(
		db,
		{
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourceKind: input.sourceKind,
			sourceRoot: input.sourceRoot,
			sourcePath: input.sourcePath,
			documentEntityId: input.fromEntityId,
			participants: [],
		},
		{
			identifier: input.toEntityId,
			edgeType: input.edgeType,
			strength: input.strength,
			reason: input.reason,
		},
		input.toEntityId,
		now,
	);
}

/** Count of participant-type edges for an artifact. Used by tests and the sync summary. */
export function countParticipantEdges(db: WriteDb, agentId: string, sourcePath: string): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM entity_dependencies
			 WHERE agent_id = ? AND source_path = ?
			   AND dependency_type IN ('authored_by', 'addressed_to', 'copied_on', 'replies_to', 'forwards')`,
		)
		.get(agentId, sourcePath) as { n: number } | undefined;
	return row?.n ?? 0;
}
