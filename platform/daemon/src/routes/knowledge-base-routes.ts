import { existsSync, readFileSync } from "node:fs";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { normalizeAndHashContent } from "../content-normalization";
import { getDbAccessor } from "../db-accessor";
import { syncVecDeleteBySourceId, syncVecInsert, vectorToBlob } from "../db-helpers";
import { fetchEmbedding } from "../embedding-fetch";
import {
	type KnowledgeBaseKind,
	type KnowledgeBaseMapping,
	buildSourceRecordId,
	createKnowledgeBase,
	hashSourceContent,
	listKnowledgeBasePolicies,
	listKnowledgeBases,
	parseKnowledgeSource,
	projectionForRow,
	readKnowledgeSource,
	resolveWorkspaceDefaultAgentIds,
	setKnowledgeBasePolicy,
	sourceMetadataForPath,
} from "../knowledge-bases";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { txPersistStructured } from "../pipeline/graph-transactions";
import { txIngestEnvelope } from "../transactions";
import { AGENTS_DIR, authConfig } from "./state";
import { toRecord } from "./utils";

interface ImportBody {
	readonly name?: unknown;
	readonly kind?: unknown;
	readonly path?: unknown;
	readonly content?: unknown;
	readonly filename?: unknown;
	readonly agentId?: unknown;
	readonly mapping?: unknown;
}

function stringValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function kindValue(value: unknown, fallback: KnowledgeBaseKind): KnowledgeBaseKind {
	const text = stringValue(value);
	if (
		text === "csv" ||
		text === "json" ||
		text === "sqlite" ||
		text === "postgres" ||
		text === "filesystem" ||
		text === "repo" ||
		text === "obsidian"
	) {
		return text;
	}
	return fallback;
}

function mappingValue(value: unknown): KnowledgeBaseMapping | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as KnowledgeBaseMapping;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function storeEmbedding(memoryId: string, contentHash: string, content: string): Promise<boolean> {
	try {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const vec = await fetchEmbedding(content, cfg.embedding);
		if (!vec || vec.length !== cfg.embedding.dimensions) return false;
		getDbAccessor().withWriteTx((db) => {
			syncVecDeleteBySourceId(db, "memory", memoryId);
			db.prepare("DELETE FROM embeddings WHERE source_type = 'memory' AND source_id = ?").run(memoryId);
			const id = crypto.randomUUID();
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
				 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
			).run(id, contentHash, vectorToBlob(vec), vec.length, memoryId, content, new Date().toISOString());
			syncVecInsert(db, id, vec);
			db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(cfg.embedding.model, memoryId);
		});
		return true;
	} catch (err) {
		logger.warn("connectors", "Embedding failed for knowledge base record", {
			memoryId,
			error: errorMessage(err),
		});
		return false;
	}
}

export function registerKnowledgeBaseRoutes(app: Hono): void {
	app.use("/api/knowledge-bases", async (c, next) => requirePermission("recall", authConfig)(c, next));
	app.use("/api/knowledge-bases/*", async (c, next) => {
		if (c.req.method === "GET") return requirePermission("recall", authConfig)(c, next);
		return requirePermission("connectors", authConfig)(c, next);
	});

	app.get("/api/knowledge-bases", (c) => {
		const items = getDbAccessor().withReadDb((db) => listKnowledgeBases(db));
		return c.json({ items });
	});

	app.get("/api/knowledge-bases/:id/policies", (c) => {
		const id = c.req.param("id");
		const items = getDbAccessor().withReadDb((db) => listKnowledgeBasePolicies(db, id));
		return c.json({ items });
	});

	app.post("/api/knowledge-bases/:id/agents/:agentId", async (c) => {
		const id = c.req.param("id");
		const agentId = c.req.param("agentId");
		const body = toRecord(await c.req.json().catch(() => ({}))) ?? {};
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			setKnowledgeBasePolicy(db, id, agentId, {
				allowed: typeof body.allowed === "boolean" ? body.allowed : undefined,
				enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
				now,
			});
		});
		return c.json({ ok: true });
	});

	app.post("/api/knowledge-bases/connect", async (c) => {
		const body = toRecord(await c.req.json().catch(() => ({}))) ?? {};
		const name = stringValue(body.name);
		if (!name) return c.json({ error: "name is required" }, 400);
		const kind = kindValue(body.kind, "sqlite");
		if (kind !== "sqlite" && kind !== "postgres") return c.json({ error: "kind must be sqlite or postgres" }, 400);
		const agentId = stringValue(body.agentId) ?? resolveWorkspaceDefaultAgentIds(AGENTS_DIR)[0] ?? "default";
		const now = new Date().toISOString();
		const id = getDbAccessor().withWriteTx((db) =>
			createKnowledgeBase(db, {
				id: crypto.randomUUID(),
				name,
				kind,
				sourceUri: stringValue(body.uri),
				sourceConfig: body.config ?? {},
				mapping: mappingValue(body.mapping),
				createdByAgentId: agentId,
				defaultAgentIds: resolveWorkspaceDefaultAgentIds(AGENTS_DIR),
				now,
			}),
		);
		return c.json({ id, name, kind, status: "registered" });
	});

	app.post("/api/knowledge-bases/import", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as ImportBody;
		const requestedPath = stringValue(body.path);
		const inlineContent = typeof body.content === "string" ? body.content : null;
		if (!requestedPath && inlineContent === null) return c.json({ error: "path or content is required" }, 400);

		let sourceUri = stringValue(body.filename) ?? "inline";
		let content = inlineContent ?? "";
		let kind: KnowledgeBaseKind = kindValue(body.kind, "json");
		let metadata: Record<string, unknown> = {};
		try {
			if (requestedPath) {
				if (!existsSync(requestedPath)) return c.json({ error: "source path does not exist" }, 400);
				const source = readKnowledgeSource(requestedPath, stringValue(body.kind) ?? undefined);
				kind = source.kind;
				content = source.content;
				sourceUri = source.sourceUri;
				metadata = sourceMetadataForPath(source.sourceUri);
			} else if (kind === "filesystem" && inlineContent === null) {
				content = readFileSync(sourceUri, "utf8");
			}
		} catch (err) {
			return c.json({ error: `failed to read source: ${errorMessage(err)}` }, 400);
		}

		const name =
			stringValue(body.name) ??
			(requestedPath ? (sourceUri.split("/").pop() ?? "knowledge-base") : "inline-knowledge-base");
		const agentId = stringValue(body.agentId) ?? resolveWorkspaceDefaultAgentIds(AGENTS_DIR)[0] ?? "default";
		const mapping = mappingValue(body.mapping);
		const now = new Date().toISOString();
		const rows = parseKnowledgeSource({ kind, content });
		if (rows.length === 0) return c.json({ error: "source contained no importable records" }, 400);

		let imported = 0;
		let skipped = 0;
		let embedded = 0;
		let attributes = 0;
		const errors: string[] = [];

		const kbId = getDbAccessor().withWriteTx((db) =>
			createKnowledgeBase(db, {
				id: crypto.randomUUID(),
				name,
				kind,
				sourceUri,
				sourceConfig: metadata,
				mapping,
				createdByAgentId: agentId,
				defaultAgentIds: resolveWorkspaceDefaultAgentIds(AGENTS_DIR),
				now,
			}),
		);

		for (const row of rows) {
			try {
				const sourceKey = row.sourceKey;
				const recordId = buildSourceRecordId(kbId, sourceKey);
				const sourceHash = hashSourceContent(row.content);
				const projection = projectionForRow(name, kind, row, mapping);
				const bodyContent = mapping?.content
					? row.values[
							String(mapping.content)
								.trim()
								.toLowerCase()
								.replace(/[^a-z0-9]+/g, "_")
								.replace(/^_+|_+$/g, "")
						] || row.content
					: row.content;
				const memoryContent = `[Knowledge base: ${name}]\n[Source: ${sourceKey}]\n\n${bodyContent}`;
				const normalized = normalizeAndHashContent(memoryContent);
				const memoryId = crypto.randomUUID();

				const inserted = getDbAccessor().withWriteTx((db) => {
					const existing = db
						.prepare(
							"SELECT memory_id, source_hash FROM knowledge_base_records WHERE knowledge_base_id = ? AND source_key = ?",
						)
						.get(kbId, sourceKey) as { memory_id: string | null; source_hash: string } | undefined;
					if (existing?.source_hash === sourceHash && existing.memory_id) return false;

					txIngestEnvelope(db, {
						id: memoryId,
						content: normalized.storageContent,
						normalizedContent: normalized.normalizedContent,
						contentHash: normalized.contentHash,
						who: `knowledge-base:${name}`,
						why: "knowledge_base_import",
						project: null,
						importance: 0.55,
						type: "knowledge_base_record",
						tags: `knowledge-base,knowledge-base:${name},${kind}`,
						pinned: 0,
						isDeleted: 0,
						extractionStatus: "complete",
						extractionModel: "knowledge-base-import",
						updatedBy: "knowledge-base-import",
						sourceType: "knowledge_base",
						sourceId: `${kbId}:${sourceKey}`,
						knowledgeBaseId: kbId,
						knowledgeBaseRecordId: recordId,
						agentId,
						visibility: "global",
						createdAt: now,
					});

					db.prepare(
						`INSERT INTO knowledge_base_records
						 (id, knowledge_base_id, source_kind, source_uri, source_key, source_hash,
						  content, metadata_json, status, memory_id, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
						 ON CONFLICT(knowledge_base_id, source_key) DO UPDATE SET
						   source_hash = excluded.source_hash,
						   content = excluded.content,
						   metadata_json = excluded.metadata_json,
						   status = 'active',
						   memory_id = excluded.memory_id,
						   updated_at = excluded.updated_at`,
					).run(
						recordId,
						kbId,
						kind,
						sourceUri,
						sourceKey,
						sourceHash,
						row.content,
						JSON.stringify(row.metadata),
						memoryId,
						now,
						now,
					);

					const structured = txPersistStructured(db, {
						entities: [],
						aspects: projection.aspects,
						sourceMemoryId: memoryId,
						content: normalized.storageContent,
						agentId,
						now,
					});
					attributes += structured.attributesCreated;

					const hintStmt = db.prepare(
						`INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
						 VALUES (?, ?, ?, ?, ?)`,
					);
					for (const hint of projection.hints) {
						const h = hint.trim();
						if (h.length >= 5 && h.length <= 300) hintStmt.run(crypto.randomUUID(), memoryId, agentId, h, now);
					}
					return true;
				});

				if (!inserted) {
					skipped++;
					continue;
				}
				imported++;
				if (await storeEmbedding(memoryId, normalized.contentHash, normalized.storageContent)) embedded++;
			} catch (err) {
				errors.push(`${row.sourceKey}: ${errorMessage(err)}`);
			}
		}

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE knowledge_bases SET last_synced_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(
				now,
				errors.length > 0 ? errors.slice(0, 5).join("; ") : null,
				now,
				kbId,
			);
		});

		return c.json({ id: kbId, name, kind, imported, skipped, embedded, attributes, errors });
	});
}
