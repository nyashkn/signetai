/**
 * Migration 064: durable session registry.
 *
 * Cross-agent presence is intentionally live and in-memory. This registry gives
 * sessions a durable lifecycle row that can point at the canonical JSONL
 * transcript substrate and survive daemon restarts.
 */
export function up(db: { exec(sql: string): void }): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_registry (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			session_key TEXT,
			session_id TEXT,
			harness TEXT NOT NULL,
			app_id TEXT NOT NULL,
			app_label TEXT NOT NULL,
			project TEXT,
			cwd TEXT,
			runtime_path TEXT,
			provider TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			started_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			ended_at TEXT,
			end_reason TEXT,
			transcript_path TEXT,
			updated_at TEXT NOT NULL,
			CHECK (status IN ('active', 'ended', 'stale')),
			CHECK (runtime_path IS NULL OR runtime_path IN ('plugin', 'legacy'))
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_session_registry_agent_harness_session_key
			ON session_registry(agent_id, harness, session_key)
			WHERE session_key IS NOT NULL;

		CREATE UNIQUE INDEX IF NOT EXISTS idx_session_registry_agent_harness_session_id
			ON session_registry(agent_id, harness, session_id)
			WHERE session_id IS NOT NULL;

		CREATE INDEX IF NOT EXISTS idx_session_registry_active
			ON session_registry(agent_id, status, last_seen_at DESC);

		CREATE INDEX IF NOT EXISTS idx_session_registry_project
			ON session_registry(agent_id, project, status, last_seen_at DESC);
	`);
}
