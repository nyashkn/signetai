/**
 * Trail queries — who touched a thing, and how a thing connects to another.
 *
 * Two gaps this closes. `traverseKnowledgeGraph` expands exactly one dependency
 * hop (its own doc says so), and every lookup keys on one exact canonical name,
 * so `what_touched("Matt West")` misses everything filed under his address.
 *
 * Both are fixed by the same two ideas:
 *
 * 1. **Resolve the identity first, then query.** A person is a *set* of entity
 *    ids — the row bearing the name, every row an alias points at, and every
 *    row whose canonical name an alias spells. P4 populated those aliases, so
 *    this works before any merge proposal is approved; approving one just makes
 *    the set smaller.
 * 2. **Walk with a recursive CTE**, bounded by depth, strength and a row cap,
 *    following edges in both directions — `authored_by` runs artifact→person,
 *    so a person's work is only reachable by walking edges backwards.
 */

import type { ReadDb } from "./db-accessor";
import { getDbAccessor } from "./db-accessor";
import { deepLinkForArtifact, parseSourceMeta } from "./source-deep-link";

export interface ResolvedIdentity {
	readonly entityIds: readonly string[];
	readonly names: readonly string[];
	/** How the selector was found, for a caller that wants to explain itself. */
	readonly matchedVia: "id" | "name" | "alias" | "none";
}

export interface TouchedItem {
	readonly entityId: string;
	readonly name: string;
	readonly entityType: string;
	readonly relation: string;
	readonly strength: number;
	readonly sourceKind: string | null;
	readonly sourcePath: string | null;
	readonly occurredAt: string | null;
	readonly deepLink: string | null;
}

export interface TrailHop {
	readonly entityId: string;
	readonly name: string;
	readonly entityType: string;
	/** Edge that led here from the previous hop; null on the seed. */
	readonly relation: string | null;
	readonly deepLink: string | null;
}

export interface TrailPathResult {
	readonly hops: readonly TrailHop[];
	readonly depth: number;
	/** Weakest edge on the path — a chain is only as good as its worst link. */
	readonly strength: number;
}

export interface TrailOptions {
	readonly agentId: string;
	readonly selector: string;
	readonly maxDepth?: number;
	readonly minStrength?: number;
	readonly limit?: number;
	/** Only return paths that end on one of these entity types. */
	readonly targetTypes?: readonly string[];
}

const DEFAULT_DEPTH = 4;
const DEFAULT_MIN_STRENGTH = 0.3;
const DEFAULT_LIMIT = 50;
/** Hard ceiling on CTE rows, so a hub entity cannot walk the whole graph. */
const MAX_WALK_ROWS = 20_000;

function canonicalize(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly entity_type: string;
	readonly canonical_name: string | null;
}

/**
 * Expand one selector into every entity that is the same thing.
 *
 * Order matters: an exact id beats a name beats an alias, but once a match is
 * found the *whole* alias cluster comes back regardless of which door was used.
 * Asking for "Matt West", "matt@dock-blocks.com" or the raw id must all return
 * the same set, or a trail depends on which spelling the caller happened to
 * know.
 */
/**
 * Guard, not a limit anyone should reach. Identity clusters are a handful of
 * spellings; a run this deep means the alias table has a cycle worth noticing
 * rather than a person worth resolving.
 */
const MAX_ALIAS_HOPS = 8;

/**
 * Every entity reachable from `rootId` through the alias table, to a fixpoint.
 *
 * Aliases chain. A principal declaration puts `KN` beside two addresses while a
 * header puts `Njui` beside one of them — one hop from `KN` never reaches
 * `Njui`, so `what_touched` returned a different set depending on which
 * spelling the caller happened to type. P4 solved this at proposal-generation
 * time ("transitive collapse") and the resolver never got it.
 *
 * The expansion runs in both directions at each hop: the rows an alias points
 * at, and the rows whose canonical name an alias spells.
 */
function expandAliasCluster(db: ReadDb, agentId: string, rootId: string): EntityRow[] {
	const found = new Map<string, EntityRow>();
	let frontier: string[] = [rootId];

	for (let hop = 0; hop < MAX_ALIAS_HOPS && frontier.length > 0; hop++) {
		const seedRows = frontier.map(() => "SELECT ? AS id").join(" UNION ALL ");
		const rows = db
			.prepare(
				`WITH seed AS (${seedRows})
				 SELECT e.id, e.name, e.entity_type, e.canonical_name FROM entities e
				 WHERE e.agent_id = ? AND COALESCE(e.status, 'active') = 'active'
				   AND (
				     e.id IN (SELECT id FROM seed)
				     OR e.canonical_name IN (
				       SELECT a.canonical_alias FROM entity_aliases a
				       WHERE a.agent_id = ? AND a.status = 'active' AND a.entity_id IN (SELECT id FROM seed)
				     )
				     OR e.id IN (
				       SELECT a.entity_id FROM entity_aliases a
				       WHERE a.agent_id = ? AND a.status = 'active'
				         AND a.canonical_alias IN (SELECT canonical_name FROM entities WHERE id IN (SELECT id FROM seed))
				     )
				   )`,
			)
			.all(...frontier, agentId, agentId, agentId) as EntityRow[];

		// Only genuinely new rows extend the frontier, so a cycle terminates on
		// its own rather than on the hop guard.
		const next: string[] = [];
		for (const row of rows) {
			if (found.has(row.id)) continue;
			found.set(row.id, row);
			next.push(row.id);
		}
		frontier = next;
	}

	return [...found.values()];
}

export function resolveIdentityInTx(db: ReadDb, agentId: string, selector: string): ResolvedIdentity {
	const raw = selector.trim();
	if (raw.length === 0) return { entityIds: [], names: [], matchedVia: "none" };
	const canonical = canonicalize(raw);

	const byId = db
		.prepare("SELECT id, name, entity_type, canonical_name FROM entities WHERE id = ? AND agent_id = ?")
		.get(raw, agentId) as EntityRow | undefined;
	const byName = byId
		? undefined
		: (db
				.prepare(
					`SELECT id, name, entity_type, canonical_name FROM entities
					 WHERE agent_id = ? AND COALESCE(status, 'active') = 'active'
					   AND (canonical_name = ? OR LOWER(name) = ?)
					 ORDER BY COALESCE(mentions, 0) DESC LIMIT 1`,
				)
				.get(agentId, canonical, canonical) as EntityRow | undefined);

	const seed = byId ?? byName;
	const aliasSeedId = seed
		? null
		: ((
				db
					.prepare(
						`SELECT entity_id FROM entity_aliases
						 WHERE agent_id = ? AND canonical_alias = ? AND status = 'active' LIMIT 1`,
					)
					.get(agentId, canonical) as { entity_id: string } | undefined
			)?.entity_id ?? null);

	const rootId = seed?.id ?? aliasSeedId;
	if (rootId === null || rootId === undefined) return { entityIds: [], names: [], matchedVia: "none" };

	const cluster = expandAliasCluster(db, agentId, rootId);
	const rows = cluster.length > 0 ? cluster : seed ? [seed] : [];
	return {
		entityIds: rows.map((row) => row.id),
		names: rows.map((row) => row.name),
		matchedVia: byId ? "id" : byName ? "name" : "alias",
	};
}

function placeholders(count: number): string {
	return new Array(count).fill("?").join(", ");
}

function linkFor(sourceKind: string | null, sourcePath: string | null, metaJson: string | null): string | null {
	if (sourceKind === null || sourcePath === null) return null;
	return deepLinkForArtifact({ sourceKind, sourcePath, meta: parseSourceMeta(metaJson) }) ?? null;
}

/**
 * Everything one identity is attached to, one hop out, deep-linked.
 *
 * Deliberately flat rather than a walk: this is the profile-page query and the
 * cheap first answer to "what have we given them to act on". `trailFrom` is
 * where multi-hop lives.
 */
export function whatTouched(options: TrailOptions): {
	readonly identity: ResolvedIdentity;
	readonly items: readonly TouchedItem[];
} {
	const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 500);
	const minStrength = options.minStrength ?? DEFAULT_MIN_STRENGTH;

	return getDbAccessor().withReadDb((db) => {
		const identity = resolveIdentityInTx(db, options.agentId, options.selector);
		if (identity.entityIds.length === 0) return { identity, items: [] };

		const ids = identity.entityIds;
		const rows = db
			.prepare(
				`SELECT other.id AS entity_id, other.name AS name, other.entity_type AS entity_type,
				        d.dependency_type AS relation, COALESCE(d.strength, 1) AS strength,
				        d.source_kind AS source_kind, d.source_path AS source_path,
				        a.source_meta_json AS meta, COALESCE(a.captured_at, d.created_at) AS occurred_at
				 FROM entity_dependencies d
				 JOIN entities other
				   ON other.id = CASE WHEN d.target_entity_id IN (${placeholders(ids.length)})
				                      THEN d.source_entity_id ELSE d.target_entity_id END
				 LEFT JOIN memory_artifacts a
				   ON a.agent_id = d.agent_id AND a.source_path = d.source_path
				      AND COALESCE(a.is_deleted, 0) = 0
				 WHERE d.agent_id = ?
				   AND COALESCE(d.status, 'active') = 'active'
				   AND COALESCE(d.strength, 1) >= ?
				   AND (d.target_entity_id IN (${placeholders(ids.length)})
				        OR d.source_entity_id IN (${placeholders(ids.length)}))
				   AND other.id NOT IN (${placeholders(ids.length)})
				   AND COALESCE(other.status, 'active') = 'active'
				 GROUP BY other.id, d.dependency_type, d.source_path
				 ORDER BY occurred_at DESC, other.name
				 LIMIT ?`,
			)
			.all(...ids, options.agentId, minStrength, ...ids, ...ids, ...ids, limit) as Array<{
			entity_id: string;
			name: string;
			entity_type: string;
			relation: string;
			strength: number;
			source_kind: string | null;
			source_path: string | null;
			meta: string | null;
			occurred_at: string | null;
		}>;

		return {
			identity,
			items: rows.map((row) => ({
				entityId: row.entity_id,
				name: row.name,
				entityType: row.entity_type,
				relation: row.relation,
				strength: row.strength,
				sourceKind: row.source_kind,
				sourcePath: row.source_path,
				occurredAt: row.occurred_at,
				deepLink: linkFor(row.source_kind, row.source_path, row.meta),
			})),
		};
	});
}

interface WalkRow {
	readonly entity_id: string;
	readonly depth: number;
	readonly path_ids: string;
	readonly path_types: string;
	readonly weakest: number;
}

/**
 * Ordered provenance chains out of one identity.
 *
 * Edges are followed in **both** directions on purpose. The connector writes
 * `authored_by` as artifact→person, so a person's own messages are only
 * reachable by walking that edge backwards; insisting on direction would return
 * an empty trail for every human in the graph.
 *
 * Cycles are cut by string containment on the accumulated id path, which is
 * what SQLite gives you without a recursive array type. The `MAX_WALK_ROWS` cap
 * is the real guard — a hub entity like a shared mailbox otherwise fans out
 * across the whole graph before any LIMIT applies.
 */
export function trailFrom(options: TrailOptions): {
	readonly identity: ResolvedIdentity;
	readonly paths: readonly TrailPathResult[];
} {
	const maxDepth = Math.min(Math.max(options.maxDepth ?? DEFAULT_DEPTH, 1), 6);
	const minStrength = options.minStrength ?? DEFAULT_MIN_STRENGTH;
	const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 200);

	return getDbAccessor().withReadDb((db) => {
		const identity = resolveIdentityInTx(db, options.agentId, options.selector);
		if (identity.entityIds.length === 0) return { identity, paths: [] };

		const ids = identity.entityIds;
		const walk = db
			.prepare(
				`WITH RECURSIVE walk(entity_id, depth, path_ids, path_types, weakest) AS (
				   SELECT id, 0, '|' || id || '|', '', 1.0
				   FROM entities
				   WHERE agent_id = ? AND id IN (${placeholders(ids.length)})
				   UNION ALL
				   SELECT next.id, w.depth + 1,
				          w.path_ids || next.id || '|',
				          CASE WHEN w.path_types = '' THEN d.dependency_type
				               ELSE w.path_types || '>' || d.dependency_type END,
				          MIN(w.weakest, COALESCE(d.strength, 1))
				   FROM walk w
				   JOIN entity_dependencies d
				     ON (d.source_entity_id = w.entity_id OR d.target_entity_id = w.entity_id)
				    AND d.agent_id = ?
				    AND COALESCE(d.status, 'active') = 'active'
				    AND COALESCE(d.strength, 1) >= ?
				   JOIN entities next
				     ON next.id = CASE WHEN d.source_entity_id = w.entity_id
				                       THEN d.target_entity_id ELSE d.source_entity_id END
				    AND COALESCE(next.status, 'active') = 'active'
				   WHERE w.depth < ?
				     AND instr(w.path_ids, '|' || next.id || '|') = 0
				 )
				 SELECT entity_id, depth, path_ids, path_types, weakest
				 FROM walk WHERE depth > 0
				 LIMIT ?`,
			)
			.all(options.agentId, ...ids, options.agentId, minStrength, maxDepth, MAX_WALK_ROWS) as WalkRow[];

		const wanted = options.targetTypes ? new Set(options.targetTypes) : null;
		const detail = new Map<string, { name: string; entityType: string; kind: string | null; path: string | null }>();
		const needed = new Set(walk.flatMap((row) => row.path_ids.split("|").filter((id) => id.length > 0)));
		if (needed.size > 0) {
			const list = [...needed];
			for (const row of db
				.prepare(
					`SELECT e.id, e.name, e.entity_type, e.source_kind, e.source_path
					 FROM entities e WHERE e.agent_id = ? AND e.id IN (${placeholders(list.length)})`,
				)
				.all(options.agentId, ...list) as Array<{
				id: string;
				name: string;
				entity_type: string;
				source_kind: string | null;
				source_path: string | null;
			}>) {
				detail.set(row.id, {
					name: row.name,
					entityType: row.entity_type,
					kind: row.source_kind,
					path: row.source_path,
				});
			}
		}

		const links = new Map<string, string | null>();
		const artifactPaths = [...detail.values()].map((row) => row.path).filter((path): path is string => path !== null);
		if (artifactPaths.length > 0) {
			for (const row of db
				.prepare(
					`SELECT source_path, source_kind, source_meta_json FROM memory_artifacts
					 WHERE agent_id = ? AND COALESCE(is_deleted, 0) = 0
					   AND source_path IN (${placeholders(artifactPaths.length)})`,
				)
				.all(options.agentId, ...artifactPaths) as Array<{
				source_path: string;
				source_kind: string;
				source_meta_json: string | null;
			}>) {
				links.set(row.source_path, linkFor(row.source_kind, row.source_path, row.source_meta_json));
			}
		}

		const paths: TrailPathResult[] = [];
		for (const row of walk) {
			const entityIds = row.path_ids.split("|").filter((id) => id.length > 0);
			const last = entityIds[entityIds.length - 1];
			if (last === undefined) continue;
			if (wanted && !wanted.has(detail.get(last)?.entityType ?? "")) continue;
			const relations = row.path_types.length > 0 ? row.path_types.split(">") : [];
			paths.push({
				depth: row.depth,
				strength: row.weakest,
				hops: entityIds.map((id, index) => {
					const info = detail.get(id);
					return {
						entityId: id,
						name: info?.name ?? id,
						entityType: info?.entityType ?? "unknown",
						relation: index === 0 ? null : (relations[index - 1] ?? null),
						deepLink: info?.path ? (links.get(info.path) ?? null) : null,
					};
				}),
			});
		}

		// Shortest and strongest first: a two-hop chain through an asserted header
		// is better provenance than a five-hop chain through weak inferred edges.
		paths.sort((a, b) => a.depth - b.depth || b.strength - a.strength);
		return { identity, paths: paths.slice(0, limit) };
	});
}
