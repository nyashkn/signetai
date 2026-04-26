import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { watch } from "chokidar";
import { getDbAccessor } from "./db-accessor";
import { ingestKnowledgeBaseRows, tombstoneMissingKnowledgeBaseRecords } from "./knowledge-base-ingest";
import {
	type KnowledgeBaseKind,
	type KnowledgeBaseSourceRecord,
	type KnowledgeSourceRow,
	listActiveKnowledgeBaseSources,
	normalizeKnowledgeFieldKey,
	parseKnowledgeSource,
	readKnowledgeSource,
	sourceMetadataForPath,
} from "./knowledge-bases";
import { logger } from "./logger";

export interface KnowledgeBaseSyncResult {
	readonly imported: number;
	readonly skipped: number;
	readonly embedded: number;
	readonly attributes: number;
	readonly relationships: number;
	readonly tombstoned: number;
	readonly errors: readonly string[];
}

export interface KnowledgeBaseSyncHandle {
	readonly syncExisting: () => Promise<number>;
	readonly refresh: () => Promise<number>;
	readonly close: () => Promise<void>;
}

const DEFAULT_FILE_EXTENSIONS = new Set([".csv", ".json", ".md", ".markdown", ".txt"]);
let activeRefresh: (() => Promise<number>) | null = null;

function stringConfig(source: KnowledgeBaseSourceRecord, key: string): string | null {
	const value = source.sourceConfig[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberConfig(source: KnowledgeBaseSourceRecord, key: string, fallback: number): number {
	const value = source.sourceConfig[key];
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(1_000, value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return Math.max(1_000, parsed);
	}
	return fallback;
}

function shouldSkipPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return (
		/(^|\/)\.git(\/|$)/.test(normalized) ||
		/(^|\/)node_modules(\/|$)/.test(normalized) ||
		/(^|\/)\.graphiq(\/|$)/.test(normalized) ||
		/(^|\/)dist(\/|$)/.test(normalized)
	);
}

function walkFiles(root: string, extensions = DEFAULT_FILE_EXTENSIONS): string[] {
	if (!existsSync(root)) return [];
	const stat = statSync(root);
	if (stat.isFile()) return extensions.has(extname(root).toLowerCase()) ? [root] : [];
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (shouldSkipPath(path)) continue;
		if (entry.isDirectory()) out.push(...walkFiles(path, extensions));
		else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) out.push(path);
	}
	return out.sort();
}

function detectKind(path: string): KnowledgeBaseKind {
	const ext = extname(path).toLowerCase();
	if (ext === ".csv") return "csv";
	if (ext === ".json") return "json";
	return "filesystem";
}

function rowsForFile(source: KnowledgeBaseSourceRecord, filePath: string): readonly KnowledgeSourceRow[] {
	const resolved = resolve(filePath);
	const root = source.sourceUri ? resolve(source.sourceUri) : resolved;
	const rel = statSync(root).isDirectory() ? relative(root, resolved) : basename(resolved);
	const read = readKnowledgeSource(resolved, detectKind(resolved));
	return parseKnowledgeSource({ kind: read.kind, content: read.content }).map((row) => ({
		...row,
		sourceKey: `${rel.replace(/\\/g, "/")}:${row.sourceKey}`,
		metadata: { ...row.metadata, ...sourceMetadataForPath(resolved), relativePath: rel, sourceUri: resolved },
	}));
}

async function indexFileSource(source: KnowledgeBaseSourceRecord): Promise<KnowledgeBaseSyncResult> {
	if (!source.sourceUri) throw new Error("knowledge base source_uri is required");
	const activeKeys = new Set<string>();
	let imported = 0;
	let skipped = 0;
	let embedded = 0;
	let attributes = 0;
	let relationships = 0;
	const errors: string[] = [];
	for (const file of walkFiles(source.sourceUri)) {
		try {
			const rows = rowsForFile(source, file);
			for (const row of rows) activeKeys.add(row.sourceKey);
			const result = await ingestKnowledgeBaseRows({
				knowledgeBaseId: source.id,
				name: source.name,
				kind: source.kind as KnowledgeBaseKind,
				sourceUri: file,
				rows,
				mapping: source.mapping,
				agentId: source.createdByAgentId,
				actor: "knowledge_base_sync",
			});
			imported += result.imported;
			skipped += result.skipped;
			embedded += result.embedded;
			attributes += result.attributes;
			relationships += result.relationships;
			errors.push(...result.errors);
		} catch (err) {
			errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const tombstoned = errors.length === 0 ? tombstoneMissingKnowledgeBaseRecords(source.id, activeKeys) : 0;
	return { imported, skipped, embedded, attributes, relationships, tombstoned, errors };
}

function sanitizeIdentifier(value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
	return `"${value.replace(/"/g, '""')}"`;
}

function readOnlyQuery(value: string): string {
	const trimmed = value.trim();
	if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Database sync query must be read-only SELECT SQL");
	if (/[;\s](insert|update|delete|drop|alter|create|truncate|attach|detach|vacuum|reindex)\b/i.test(trimmed)) {
		throw new Error("Database sync query must not contain mutation statements");
	}
	return trimmed;
}

function rowFromSql(value: Record<string, unknown>, index: number, primaryKey: string | null): KnowledgeSourceRow {
	const values: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) values[normalizeKnowledgeFieldKey(key)] = String(item ?? "");
	const pk = primaryKey ? values[normalizeKnowledgeFieldKey(primaryKey)] : null;
	return {
		sourceKey: pk ? `pk:${pk}` : `row:${index + 1}`,
		content: JSON.stringify(value, null, 2),
		metadata: { row: index + 1 },
		values,
	};
}

async function readSqliteRows(source: KnowledgeBaseSourceRecord): Promise<readonly KnowledgeSourceRow[]> {
	if (!source.sourceUri) throw new Error("SQLite source uri is required");
	const table = stringConfig(source, "table");
	const query = stringConfig(source, "query");
	const primaryKey = stringConfig(source, "primaryKey") ?? stringConfig(source, "primary_key");
	const limit = numberConfig(source, "limit", 1_000);
	const db = new Database(source.sourceUri, { readonly: true });
	try {
		const sql = query ? readOnlyQuery(query) : `SELECT * FROM ${sanitizeIdentifier(table ?? "")} LIMIT ${limit}`;
		return (db.query(sql).all() as Array<Record<string, unknown>>).map((row, index) =>
			rowFromSql(row, index, primaryKey),
		);
	} finally {
		db.close();
	}
}

async function readPostgresRows(source: KnowledgeBaseSourceRecord): Promise<readonly KnowledgeSourceRow[]> {
	if (!source.sourceUri) throw new Error("Postgres source uri is required");
	const table = stringConfig(source, "table");
	const query = stringConfig(source, "query");
	const primaryKey = stringConfig(source, "primaryKey") ?? stringConfig(source, "primary_key");
	const limit = numberConfig(source, "limit", 1_000);
	const client = new Bun.SQL(source.sourceUri);
	try {
		const rows = query
			? ((await client.unsafe(readOnlyQuery(query))) as Array<Record<string, unknown>>)
			: ((await client.unsafe(`SELECT * FROM ${sanitizeIdentifier(table ?? "")} LIMIT ${limit}`)) as Array<
					Record<string, unknown>
				>);
		return rows.map((row, index) => rowFromSql(row, index, primaryKey));
	} finally {
		await client.close();
	}
}

async function indexDatabaseSource(source: KnowledgeBaseSourceRecord): Promise<KnowledgeBaseSyncResult> {
	const rows = source.kind === "sqlite" ? await readSqliteRows(source) : await readPostgresRows(source);
	const result = await ingestKnowledgeBaseRows({
		knowledgeBaseId: source.id,
		name: source.name,
		kind: source.kind as KnowledgeBaseKind,
		sourceUri: source.sourceUri,
		rows,
		mapping: source.mapping,
		agentId: source.createdByAgentId,
		actor: "knowledge_base_database_sync",
	});
	const tombstoned = tombstoneMissingKnowledgeBaseRecords(source.id, new Set(rows.map((row) => row.sourceKey)));
	return { ...result, tombstoned };
}

export async function indexKnowledgeBaseSource(id: string): Promise<KnowledgeBaseSyncResult> {
	const source = getDbAccessor().withReadDb((db) => listActiveKnowledgeBaseSources(db).find((item) => item.id === id));
	if (!source) throw new Error(`Knowledge base not found: ${id}`);
	if (source.kind === "filesystem" || source.kind === "repo" || source.kind === "obsidian")
		return indexFileSource(source);
	if (source.kind === "sqlite" || source.kind === "postgres") return indexDatabaseSource(source);
	return { imported: 0, skipped: 0, embedded: 0, attributes: 0, relationships: 0, tombstoned: 0, errors: [] };
}

function sourceCanWatch(source: KnowledgeBaseSourceRecord): boolean {
	if (source.kind !== "filesystem" && source.kind !== "repo" && source.kind !== "obsidian") return false;
	return source.sourceConfig.watch !== false && typeof source.sourceUri === "string" && existsSync(source.sourceUri);
}

function sourceCanPoll(source: KnowledgeBaseSourceRecord): boolean {
	return source.kind === "sqlite" || source.kind === "postgres";
}

export function startKnowledgeBaseSync(): KnowledgeBaseSyncHandle {
	const watchers = new Map<string, { readonly watcher: ReturnType<typeof watch>; readonly clear: () => void }>();
	const pollers = new Map<string, { readonly timer: ReturnType<typeof setInterval>; readonly intervalMs: number }>();
	const watchSource = (source: KnowledgeBaseSourceRecord): void => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const schedule = (): void => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				indexKnowledgeBaseSource(source.id).catch((err) => {
					logger.warn("watcher", "Knowledge base sync failed", {
						id: source.id,
						name: source.name,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}, 750);
		};
		const watcher = watch(source.sourceUri ?? "", {
			persistent: true,
			ignoreInitial: true,
			ignored: (path) => shouldSkipPath(path),
		});
		watcher.on("add", schedule);
		watcher.on("change", schedule);
		watcher.on("unlink", schedule);
		watchers.set(source.id, { watcher, clear: () => (timer ? clearTimeout(timer) : undefined) });
	};

	const pollSource = (source: KnowledgeBaseSourceRecord): void => {
		let polling = false;
		const intervalMs = numberConfig(source, "pollIntervalMs", 60_000);
		const timer = setInterval(() => {
			if (polling) return;
			polling = true;
			indexKnowledgeBaseSource(source.id)
				.catch((err) => {
					logger.warn("watcher", "Knowledge base database polling failed", {
						id: source.id,
						name: source.name,
						error: err instanceof Error ? err.message : String(err),
					});
				})
				.finally(() => {
					polling = false;
				});
		}, intervalMs);
		timer.unref?.();
		pollers.set(source.id, { timer, intervalMs });
	};

	const closeWatcher = async (id: string): Promise<void> => {
		const item = watchers.get(id);
		if (!item) return;
		item.clear();
		await item.watcher.close();
		watchers.delete(id);
	};

	const closePoller = (id: string): void => {
		const item = pollers.get(id);
		if (!item) return;
		clearInterval(item.timer);
		pollers.delete(id);
	};

	const refresh = async (): Promise<number> => {
		const sources = getDbAccessor().withReadDb((db) => listActiveKnowledgeBaseSources(db));
		const watchable = new Set(sources.filter(sourceCanWatch).map((source) => source.id));
		for (const id of [...watchers.keys()]) {
			if (!watchable.has(id)) await closeWatcher(id);
		}
		let added = 0;
		for (const source of sources) {
			if (!sourceCanWatch(source) || watchers.has(source.id)) continue;
			watchSource(source);
			added++;
		}
		const pollable = new Map(sources.filter(sourceCanPoll).map((source) => [source.id, source]));
		for (const id of [...pollers.keys()]) {
			const source = pollable.get(id);
			if (!source || numberConfig(source, "pollIntervalMs", 60_000) !== pollers.get(id)?.intervalMs) closePoller(id);
		}
		for (const source of pollable.values()) {
			if (pollers.has(source.id)) continue;
			pollSource(source);
			added++;
		}
		return added;
	};

	void refresh();
	activeRefresh = refresh;

	return {
		async syncExisting(): Promise<number> {
			let count = 0;
			const sources = getDbAccessor().withReadDb((db) => listActiveKnowledgeBaseSources(db));
			for (const source of sources) {
				if (source.kind === "codebase") continue;
				const result = await indexKnowledgeBaseSource(source.id).catch((err) => {
					logger.warn("watcher", "Knowledge base initial sync failed", {
						id: source.id,
						error: err instanceof Error ? err.message : String(err),
					});
					return null;
				});
				if (result) count += result.imported;
			}
			return count;
		},
		refresh,
		async close(): Promise<void> {
			if (activeRefresh === refresh) activeRefresh = null;
			await Promise.all([...watchers.keys()].map((id) => closeWatcher(id)));
			for (const id of [...pollers.keys()]) closePoller(id);
		},
	};
}

export async function refreshKnowledgeBaseSyncSources(): Promise<number> {
	return activeRefresh ? activeRefresh() : 0;
}
