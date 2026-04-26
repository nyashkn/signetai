import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((c) => c.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migration 064: Knowledge bases
 *
 * Knowledge bases are named, toggleable external knowledge sources. Imports,
 * files, repos, vaults, and future remote connectors all feed the same tables:
 * a source registry, per-agent allow/enable policy, and source records linked
 * to ordinary memory rows.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS knowledge_bases (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			kind TEXT NOT NULL,
			source_uri TEXT,
			source_config_json TEXT NOT NULL DEFAULT '{}',
			mapping_json TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			created_by_agent_id TEXT NOT NULL DEFAULT 'default',
			last_synced_at TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS knowledge_base_agents (
			knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
			agent_id TEXT NOT NULL,
			allowed INTEGER NOT NULL DEFAULT 0,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (knowledge_base_id, agent_id)
		);

		CREATE TABLE IF NOT EXISTS knowledge_base_records (
			id TEXT PRIMARY KEY,
			knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
			source_kind TEXT NOT NULL,
			source_uri TEXT,
			source_key TEXT NOT NULL,
			source_hash TEXT NOT NULL,
			content TEXT NOT NULL,
			metadata_json TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL DEFAULT 'active',
			memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (knowledge_base_id, source_key)
		);
	`);

	addColumnIfMissing(db, "memories", "knowledge_base_id", "TEXT");
	addColumnIfMissing(db, "memories", "knowledge_base_record_id", "TEXT");

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_knowledge_bases_status
			ON knowledge_bases(status);
		CREATE INDEX IF NOT EXISTS idx_knowledge_base_agents_agent
			ON knowledge_base_agents(agent_id, allowed, enabled);
		CREATE INDEX IF NOT EXISTS idx_knowledge_base_records_kb
			ON knowledge_base_records(knowledge_base_id, status);
		CREATE INDEX IF NOT EXISTS idx_knowledge_base_records_memory
			ON knowledge_base_records(memory_id);
		CREATE INDEX IF NOT EXISTS idx_memories_knowledge_base
			ON memories(knowledge_base_id, knowledge_base_record_id);
	`);
}
