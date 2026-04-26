import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import type { ReadDb, WriteDb } from "./db-accessor";

export type KnowledgeBaseKind = "csv" | "json" | "sqlite" | "postgres" | "filesystem" | "repo" | "obsidian";

export interface KnowledgeBaseMapping {
	readonly entity?: string | { readonly field?: string; readonly type?: string; readonly aspect?: string };
	readonly content?: string;
	readonly aspect?: string;
	readonly fields?: Readonly<
		Record<string, { readonly aspect?: string; readonly groupKey?: string; readonly claimKey?: string }>
	>;
	readonly aspects?: Readonly<Record<string, readonly string[]>>;
	readonly hints?: readonly string[];
}

export interface KnowledgeSourceRow {
	readonly sourceKey: string;
	readonly content: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly values: Readonly<Record<string, string>>;
}

export interface KnowledgeBaseRecord {
	readonly id: string;
	readonly name: string;
	readonly kind: string;
	readonly sourceUri: string | null;
	readonly status: string;
	readonly createdByAgentId: string;
	readonly lastSyncedAt: string | null;
	readonly lastError: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface KnowledgeBasePolicyRecord {
	readonly knowledgeBaseId: string;
	readonly agentId: string;
	readonly allowed: boolean;
	readonly enabled: boolean;
}

export interface StructuredProjection {
	readonly entityName: string;
	readonly entityType: string;
	readonly aspects: Array<{
		readonly entityName: string;
		readonly entityType: string;
		readonly aspect: string;
		readonly attributes: Array<{
			readonly groupKey?: string;
			readonly claimKey?: string;
			readonly content: string;
			readonly confidence?: number;
			readonly importance?: number;
		}>;
	}>;
	readonly hints: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_{2,}/g, "_")
		.slice(0, 120);
}

function readAgentYaml(agentsDir: string): Record<string, unknown> {
	for (const name of ["agent.yaml", "AGENT.yaml", "config.yaml"]) {
		const path = `${agentsDir}/${name}`;
		if (!existsSync(path)) continue;
		try {
			return parseSimpleYaml(readFileSync(path, "utf8"));
		} catch {
			return {};
		}
	}
	return {};
}

export function resolveWorkspaceDefaultAgentIds(agentsDir: string): string[] {
	const cfg = readAgentYaml(agentsDir);
	const agent = isRecord(cfg.agent) ? cfg.agent : null;
	const candidates = [
		typeof agent?.name === "string" ? agent.name.trim() : "",
		typeof cfg.name === "string" ? cfg.name.trim() : "",
		"default",
	].filter((value) => value.length > 0);
	return [...new Set(candidates)];
}

export function createKnowledgeBase(
	db: WriteDb,
	input: {
		readonly id: string;
		readonly name: string;
		readonly kind: KnowledgeBaseKind;
		readonly sourceUri?: string | null;
		readonly sourceConfig?: unknown;
		readonly mapping?: KnowledgeBaseMapping | null;
		readonly createdByAgentId: string;
		readonly defaultAgentIds: readonly string[];
		readonly now: string;
	},
): string {
	const existing = db.prepare("SELECT id FROM knowledge_bases WHERE name = ?").get(input.name) as
		| { id: string }
		| undefined;
	const kbId = existing?.id ?? input.id;
	if (!existing) {
		db.prepare(
			`INSERT INTO knowledge_bases
			 (id, name, kind, source_uri, source_config_json, mapping_json, status,
			  created_by_agent_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		).run(
			kbId,
			input.name,
			input.kind,
			input.sourceUri ?? null,
			JSON.stringify(input.sourceConfig ?? {}),
			input.mapping ? JSON.stringify(input.mapping) : null,
			input.createdByAgentId,
			input.now,
			input.now,
		);
	} else {
		db.prepare(
			`UPDATE knowledge_bases
			 SET kind = ?, source_uri = COALESCE(?, source_uri),
			     source_config_json = ?, mapping_json = COALESCE(?, mapping_json),
			     status = 'active', updated_at = ?
			 WHERE id = ?`,
		).run(
			input.kind,
			input.sourceUri ?? null,
			JSON.stringify(input.sourceConfig ?? {}),
			input.mapping ? JSON.stringify(input.mapping) : null,
			input.now,
			kbId,
		);
	}

	for (const agentId of input.defaultAgentIds) {
		setKnowledgeBasePolicy(db, kbId, agentId, { allowed: true, enabled: true, now: input.now });
	}
	return kbId;
}

export function setKnowledgeBasePolicy(
	db: WriteDb,
	knowledgeBaseId: string,
	agentId: string,
	input: { readonly allowed?: boolean; readonly enabled?: boolean; readonly now: string },
): void {
	const existing = db
		.prepare("SELECT allowed, enabled FROM knowledge_base_agents WHERE knowledge_base_id = ? AND agent_id = ?")
		.get(knowledgeBaseId, agentId) as { allowed: number; enabled: number } | undefined;
	const allowed = input.allowed ?? (existing ? existing.allowed === 1 : false);
	const enabled = input.enabled ?? (existing ? existing.enabled === 1 : true);
	db.prepare(
		`INSERT INTO knowledge_base_agents
		 (knowledge_base_id, agent_id, allowed, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(knowledge_base_id, agent_id) DO UPDATE SET
		   allowed = excluded.allowed,
		   enabled = excluded.enabled,
		   updated_at = excluded.updated_at`,
	).run(knowledgeBaseId, agentId, allowed ? 1 : 0, enabled ? 1 : 0, input.now, input.now);
}

export function listKnowledgeBases(db: ReadDb): KnowledgeBaseRecord[] {
	return db
		.prepare(
			`SELECT id, name, kind, source_uri, status, created_by_agent_id,
			        last_synced_at, last_error, created_at, updated_at
			 FROM knowledge_bases
			 ORDER BY updated_at DESC, name ASC`,
		)
		.all()
		.map((row) => {
			const r = row as Record<string, unknown>;
			return {
				id: String(r.id),
				name: String(r.name),
				kind: String(r.kind),
				sourceUri: typeof r.source_uri === "string" ? r.source_uri : null,
				status: String(r.status),
				createdByAgentId: String(r.created_by_agent_id),
				lastSyncedAt: typeof r.last_synced_at === "string" ? r.last_synced_at : null,
				lastError: typeof r.last_error === "string" ? r.last_error : null,
				createdAt: String(r.created_at),
				updatedAt: String(r.updated_at),
			};
		});
}

export function listKnowledgeBasePolicies(db: ReadDb, knowledgeBaseId: string): KnowledgeBasePolicyRecord[] {
	return db
		.prepare(
			`SELECT knowledge_base_id, agent_id, allowed, enabled
			 FROM knowledge_base_agents
			 WHERE knowledge_base_id = ?
			 ORDER BY agent_id ASC`,
		)
		.all(knowledgeBaseId)
		.map((row) => {
			const r = row as Record<string, unknown>;
			return {
				knowledgeBaseId: String(r.knowledge_base_id),
				agentId: String(r.agent_id),
				allowed: r.allowed === 1,
				enabled: r.enabled === 1,
			};
		});
}

function parseCsvLine(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (quoted && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				quoted = !quoted;
			}
		} else if (ch === "," && !quoted) {
			cells.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	cells.push(current);
	return cells.map((cell) => cell.trim());
}

function parseCsv(content: string): KnowledgeSourceRow[] {
	const lines = content
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.filter((line) => line.trim().length > 0);
	if (lines.length === 0) return [];
	const headers = parseCsvLine(lines[0] ?? "").map((h, index) => normalizeKey(h) || `field_${index + 1}`);
	return lines.slice(1).map((line, index) => {
		const cells = parseCsvLine(line);
		const values: Record<string, string> = {};
		for (let i = 0; i < headers.length; i++) values[headers[i] ?? `field_${i + 1}`] = cells[i] ?? "";
		return {
			sourceKey: `row:${index + 1}`,
			content: JSON.stringify(values),
			metadata: { row: index + 1 },
			values,
		};
	});
}

function flatten(value: unknown, prefix = ""): Record<string, string> {
	if (!isRecord(value)) return prefix ? { [prefix]: String(value ?? "") } : {};
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		const next = prefix ? `${prefix}.${key}` : key;
		if (isRecord(item)) Object.assign(out, flatten(item, next));
		else if (Array.isArray(item))
			out[normalizeKey(next)] = item
				.map((entry) => (isRecord(entry) ? JSON.stringify(entry) : String(entry)))
				.join(", ");
		else out[normalizeKey(next)] = String(item ?? "");
	}
	return out;
}

function parseJson(content: string): KnowledgeSourceRow[] {
	const raw = JSON.parse(content) as unknown;
	const items = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.items) ? raw.items : [raw];
	return items.map((item, index) => {
		const values = flatten(item);
		return {
			sourceKey: values.id ? `id:${values.id}` : values.key ? `key:${values.key}` : `row:${index + 1}`,
			content: JSON.stringify(item, null, 2),
			metadata: { row: index + 1 },
			values,
		};
	});
}

export function parseKnowledgeSource(input: {
	readonly kind: KnowledgeBaseKind;
	readonly content: string;
}): KnowledgeSourceRow[] {
	if (input.kind === "csv") return parseCsv(input.content);
	if (input.kind === "json") return parseJson(input.content);
	return [
		{
			sourceKey: "document:1",
			content: input.content,
			metadata: {},
			values: { content: input.content },
		},
	];
}

export function readKnowledgeSource(
	path: string,
	kind?: string,
): { kind: KnowledgeBaseKind; content: string; sourceUri: string } {
	const sourceUri = resolve(path);
	const content = readFileSync(sourceUri, "utf8");
	const lower = sourceUri.toLowerCase();
	const detected =
		kind === "csv" || lower.endsWith(".csv")
			? "csv"
			: kind === "json" || lower.endsWith(".json")
				? "json"
				: "filesystem";
	return { kind: detected, content, sourceUri };
}

export function buildSourceRecordId(knowledgeBaseId: string, sourceKey: string): string {
	return createHash("sha256").update(`${knowledgeBaseId}:${sourceKey}`).digest("hex");
}

export function hashSourceContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function projectionForRow(
	kbName: string,
	kind: KnowledgeBaseKind,
	row: KnowledgeSourceRow,
	mapping?: KnowledgeBaseMapping | null,
): StructuredProjection {
	const values = row.values;
	const entityMapping = mapping?.entity;
	const entityField = typeof entityMapping === "string" ? entityMapping : entityMapping?.field;
	const entityType =
		typeof entityMapping === "object" && entityMapping.type
			? entityMapping.type
			: kind === "filesystem"
				? "document"
				: "record";
	const fallbackField = ["name", "title", "id", "key", "slug"].find((field) => values[field]?.trim());
	const entityName =
		(entityField ? values[normalizeKey(entityField)] : undefined) ||
		(fallbackField ? values[fallbackField] : undefined) ||
		`${kbName} ${row.sourceKey}`;
	const entityAspect =
		typeof entityMapping === "object" && typeof entityMapping.aspect === "string" ? entityMapping.aspect : null;
	const defaultAspect = mapping?.aspect ?? entityAspect ?? kind;
	const attributes: StructuredProjection["aspects"][number]["attributes"] = [];

	const addAttr = (field: string, value: string, aspect: string): void => {
		const trimmed = value.trim();
		if (!trimmed) return;
		const fieldCfg = mapping?.fields?.[field];
		attributes.push({
			groupKey: fieldCfg?.groupKey ?? "fields",
			claimKey: fieldCfg?.claimKey ?? field,
			content: `${field}: ${trimmed}`,
			confidence: 1,
			importance: 0.55,
		});
	};

	for (const [field, value] of Object.entries(values)) {
		if (field === normalizeKey(entityField ?? "")) continue;
		const explicitAspect = Object.entries(mapping?.aspects ?? {}).find(([, fields]) =>
			fields.map(normalizeKey).includes(field),
		)?.[0];
		addAttr(field, value, explicitAspect ?? mapping?.fields?.[field]?.aspect ?? defaultAspect);
	}

	const aspectGroups = new Map<string, typeof attributes>();
	for (const attr of attributes) {
		const aspect = mapping?.fields?.[attr.claimKey ?? ""]?.aspect ?? defaultAspect;
		const list = aspectGroups.get(aspect) ?? [];
		list.push(attr);
		aspectGroups.set(aspect, list);
	}

	return {
		entityName,
		entityType,
		aspects: [...aspectGroups.entries()].map(([aspect, attrs]) => ({
			entityName,
			entityType,
			aspect,
			attributes: attrs,
		})),
		hints: [
			...(mapping?.hints ?? []),
			`What does ${entityName} say in ${kbName}?`,
			`Find ${entityName} from ${kbName}`,
		].slice(0, 8),
	};
}

export function sourceMetadataForPath(path: string): Record<string, unknown> {
	try {
		const stat = statSync(path);
		return { path, file: basename(path), mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return { path, file: basename(path) };
	}
}
