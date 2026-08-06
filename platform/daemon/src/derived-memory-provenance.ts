import type { WriteDb } from "./db-accessor";

/** A canonical evidence record used to derive a semantic memory. */
export interface DerivedMemorySource {
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath?: string | null;
}

function required(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`Derived memory provenance ${field} is required`);
	return normalized;
}

/**
 * Record the immutable evidence identities that a derived memory depends on.
 * Callers use episodic record identity (`memory`, `artifact`, `transcript`,
 * `summary`) rather than an owning connector/source type, which makes a
 * later evidence mutation addressable through the same relation.
 */
export function linkDerivedMemorySourcesInTx(
	db: WriteDb,
	input: {
		readonly derivedMemoryId: string;
		readonly agentId: string;
		readonly sources: readonly DerivedMemorySource[];
		readonly createdAt: string;
	},
): void {
	const derivedMemoryId = required(input.derivedMemoryId, "derivedMemoryId");
	const agentId = required(input.agentId, "agentId");
	const createdAt = required(input.createdAt, "createdAt");
	const seen = new Set<string>();
	const insert = db.prepare(
		`INSERT OR IGNORE INTO derived_memory_sources
		 (derived_memory_id, source_kind, source_id, source_path, agent_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	for (const source of input.sources) {
		const sourceKind = required(source.sourceKind, "sourceKind");
		const sourceId = required(source.sourceId, "sourceId");
		const key = `${sourceKind}\u0000${sourceId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		insert.run(derivedMemoryId, sourceKind, sourceId, source.sourcePath?.trim() || null, agentId, createdAt);
	}
}

/**
 * Hide derived semantic rows immediately when one of their evidence records
 * changes. The relation is retained for audit and re-derivation; only the
 * derived row's currentness changes.
 */
export function markDerivedMemoriesStaleForSourceInTx(
	db: WriteDb,
	input: {
		readonly sourceKind: string;
		readonly sourceId: string;
		readonly agentId: string;
		readonly staleAt: string;
	},
): readonly string[] {
	const sourceKind = required(input.sourceKind, "sourceKind");
	const sourceId = required(input.sourceId, "sourceId");
	const agentId = required(input.agentId, "agentId");
	const staleAt = required(input.staleAt, "staleAt");
	const ids = db
		.prepare(
			`SELECT dms.derived_memory_id AS id
			 FROM derived_memory_sources dms
			 JOIN memories derived ON derived.id = dms.derived_memory_id
			 WHERE dms.agent_id = ?
			   AND dms.source_kind = ?
			   AND dms.source_id = ?
			   AND derived.agent_id = ?
			   AND derived.is_deleted = 0
			   AND derived.stale_at IS NULL`,
		)
		.all(agentId, sourceKind, sourceId, agentId) as Array<{ id: string }>;
	if (ids.length === 0) return [];
	db.prepare(
		`UPDATE memories
		 SET stale_at = ?
		 WHERE agent_id = ?
		   AND stale_at IS NULL
		   AND id IN (${ids.map(() => "?").join(", ")})`,
	).run(staleAt, agentId, ...ids.map((row) => row.id));
	return ids.map((row) => row.id);
}
