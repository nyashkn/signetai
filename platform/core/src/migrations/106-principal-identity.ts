import type { MigrationDb } from "./index";

function hasTable(db: MigrationDb, table: string): boolean {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
		| { name: string }
		| undefined;
	return row !== undefined;
}

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === column);
}

/**
 * Scope and type for aliases, plus a pointer to the agent's operator.
 *
 * `entity_aliases` (migration 077) was built to gate prompt injection: one
 * handle resolves to one entity, and nothing else was needed. Identity
 * resolution needs two facts it cannot express — *what kind* of handle an alias
 * is (email vs GitHub login vs phone), and *which organization* the person was
 * acting for when they used it. Both are real columns rather than an encoding
 * inside `source`, because P4 (resolution), P5 (trail queries) and P6 (identity
 * workspace) all read this table and would otherwise each re-parse one string.
 *
 * `agents.principal_entity_id` answers the separate question of *which* person
 * is the operator. It lives here rather than as an `entity_attributes` claim
 * because that table hangs off `entity_aspects` and has no `entity_id` of its
 * own — flagging one entity would mean inventing a glue aspect and a three-way
 * join to read a per-agent singleton.
 */
export function up(db: MigrationDb): void {
	if (hasTable(db, "entity_aliases")) {
		if (!hasColumn(db, "entity_aliases", "alias_kind")) {
			db.exec("ALTER TABLE entity_aliases ADD COLUMN alias_kind TEXT");
		}
		if (!hasColumn(db, "entity_aliases", "org_entity_id")) {
			// SQLite permits a REFERENCES clause on ADD COLUMN only when the default
			// is NULL, which it is. ON DELETE SET NULL keeps an alias alive when its
			// organization entity is merged away — the handle is still the person's.
			db.exec("ALTER TABLE entity_aliases ADD COLUMN org_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL");
		}
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_entity_aliases_kind
				ON entity_aliases(agent_id, alias_kind, status);
			CREATE INDEX IF NOT EXISTS idx_entity_aliases_org
				ON entity_aliases(agent_id, org_entity_id);
		`);
	}

	if (hasTable(db, "agents") && !hasColumn(db, "agents", "principal_entity_id")) {
		db.exec("ALTER TABLE agents ADD COLUMN principal_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL");
	}
}
