import type { MigrationDb } from "./index";

function hasTable(db: MigrationDb, table: string): boolean {
	// `.get()` answers `null` for no row, not `undefined` — a `!== undefined`
	// guard is always true, so this reported every table as present and the
	// migration silently did nothing. Same shape as the `hasIndexedBody` defect
	// in the email connector.
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
		| { name: string }
		| null
		| undefined;
	return row !== undefined && row !== null;
}

/**
 * What a merge consumed, so an approved merge stops being irreversible.
 *
 * `applyMergeEntities` hard-deletes the source entity and its
 * `memory_entity_mentions` after repointing everything at the target. The only
 * record was a JSON blob in `ontology_proposals.result` listing names and
 * counts — enough to say *that* a merge happened, not enough to say which edge
 * used to belong to whom. So "split identities" was deferred to v1.5 against a
 * lineage that did not exist, and every merge approved in the meantime was a
 * one-way door.
 *
 * One row per consumed source entity. `source_row_json` is the entity as it
 * stood immediately before deletion; `moved_json` names the rows that were
 * repointed onto the target, which is the part attribution cannot be rebuilt
 * without — after the merge those rows are indistinguishable from the target's
 * own.
 *
 * Deliberately not a foreign key onto `entities(id)`: the source id it records
 * is precisely the row that no longer exists.
 */
export function up(db: MigrationDb): void {
	if (hasTable(db, "entity_merge_lineage")) return;

	db.exec(`
		CREATE TABLE entity_merge_lineage (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			proposal_id TEXT,
			actor TEXT,
			target_entity_id TEXT NOT NULL,
			source_entity_id TEXT NOT NULL,
			source_name TEXT NOT NULL,
			source_canonical_name TEXT,
			source_entity_type TEXT,
			source_row_json TEXT NOT NULL,
			moved_json TEXT NOT NULL,
			merged_at TEXT NOT NULL
		);
	`);

	// Reading lineage is always "what happened to this row" or "what did this
	// row absorb", so both directions are indexed.
	db.exec("CREATE INDEX idx_entity_merge_lineage_source ON entity_merge_lineage (agent_id, source_entity_id)");
	db.exec("CREATE INDEX idx_entity_merge_lineage_target ON entity_merge_lineage (agent_id, target_entity_id)");
}
