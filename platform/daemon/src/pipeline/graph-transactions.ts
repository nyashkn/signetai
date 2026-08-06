/**
 * Graph entity/relation cleanup for the extraction pipeline.
 *
 * Separated from transactions.ts (which handles memory CRUD) to keep
 * both files under the 700 LOC soft cap.
 *
 * All functions expect to run inside a withWriteTx closure.
 */

import type { WriteDb } from "../db-accessor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecrementInput {
	readonly entityIds: readonly string[];
}

export interface DecrementResult {
	readonly entitiesOrphaned: number;
}

// ---------------------------------------------------------------------------
// Exported transaction closures
// ---------------------------------------------------------------------------

/**
 * Decrement entity mention counts after memory purge. Entities that
 * drop to 0 mentions are deleted, and dangling relations are cleaned.
 *
 * Call inside `accessor.withWriteTx(db => txDecrementEntityMentions(db, input))`.
 */
export function txDecrementEntityMentions(db: WriteDb, input: DecrementInput): DecrementResult {
	if (input.entityIds.length === 0) return { entitiesOrphaned: 0 };

	// Decrement mentions (floor at 0)
	for (const entityId of input.entityIds) {
		db.prepare(
			`UPDATE entities
			 SET mentions = MAX(0, mentions - 1)
			 WHERE id = ?`,
		).run(entityId);
	}

	// Delete only entities affected by this purge. A retention pass may process
	// one agent while another agent already has an unrelated zero-mention row.
	const placeholders = input.entityIds.map(() => "?").join(", ");
	const orphaned = db
		.prepare(`SELECT id FROM entities WHERE mentions = 0 AND id IN (${placeholders})`)
		.all(...input.entityIds) as Array<{ id: string }>;

	if (orphaned.length > 0) {
		const orphanedPlaceholders = orphaned.map(() => "?").join(", ");
		const ids = orphaned.map((r) => r.id);

		// Clean dangling relations first
		db.prepare(
			`DELETE FROM relations
			 WHERE source_entity_id IN (${orphanedPlaceholders})
			    OR target_entity_id IN (${orphanedPlaceholders})`,
		).run(...ids, ...ids);

		// Clean any remaining mention links
		db.prepare(
			`DELETE FROM memory_entity_mentions
			 WHERE entity_id IN (${orphanedPlaceholders})`,
		).run(...ids);

		// Delete the entities themselves
		db.prepare(`DELETE FROM entities WHERE id IN (${orphanedPlaceholders})`).run(...ids);
	}

	return { entitiesOrphaned: orphaned.length };
}
