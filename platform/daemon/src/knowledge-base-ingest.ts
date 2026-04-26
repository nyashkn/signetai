import { normalizeAndHashContent } from "./content-normalization";
import { type WriteDb, getDbAccessor } from "./db-accessor";
import { syncVecDeleteBySourceId, syncVecInsert, vectorToBlob } from "./db-helpers";
import { fetchEmbedding } from "./embedding-fetch";
import {
	type KnowledgeBaseKind,
	type KnowledgeBaseMapping,
	type KnowledgeSourceRow,
	buildSourceRecordId,
	hashSourceContent,
	projectionForRow,
} from "./knowledge-bases";
import { logger } from "./logger";
import { loadMemoryConfig } from "./memory-config";
import { txPersistStructured } from "./pipeline/graph-transactions";
import { AGENTS_DIR } from "./routes/state";
import { txIngestEnvelope } from "./transactions";

export interface KnowledgeBaseIngestInput {
	readonly knowledgeBaseId: string;
	readonly name: string;
	readonly kind: KnowledgeBaseKind;
	readonly sourceUri: string | null;
	readonly rows: readonly KnowledgeSourceRow[];
	readonly mapping?: KnowledgeBaseMapping | null;
	readonly agentId: string;
	readonly actor: string;
	readonly now?: string;
}

export interface KnowledgeBaseIngestResult {
	readonly imported: number;
	readonly skipped: number;
	readonly embedded: number;
	readonly attributes: number;
	readonly relationships: number;
	readonly errors: readonly string[];
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function rowSourceUri(row: KnowledgeSourceRow, fallback: string | null): string | null {
	const uri = row.metadata.sourceUri;
	return typeof uri === "string" && uri.trim() ? uri : fallback;
}

function mappedContent(row: KnowledgeSourceRow, mapping?: KnowledgeBaseMapping | null): string {
	if (!mapping?.content) return row.content;
	const key = String(mapping.content)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return row.values[key] || row.content;
}

function normalizeName(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function mappedValue(row: KnowledgeSourceRow, field: string | undefined): string | null {
	if (!field) return null;
	const value =
		row.values[
			field
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "_")
				.replace(/^_+|_+$/g, "")
		];
	return value?.trim() ? value.trim() : null;
}

function upsertMappedEntity(db: WriteDb, name: string, type: string, agentId: string, now: string): string | null {
	const trimmed = name.trim();
	if (trimmed.length < 2) return null;
	const canonical = normalizeName(trimmed);
	const existing = db
		.prepare(
			`SELECT id, entity_type FROM entities
			 WHERE (canonical_name = ? AND agent_id = ?) OR name = ?
			 LIMIT 1`,
		)
		.get(canonical, agentId, trimmed) as { id: string; entity_type: string } | undefined;
	if (existing) {
		db.prepare("UPDATE entities SET mentions = mentions + 1, updated_at = ? WHERE id = ?").run(now, existing.id);
		if (existing.entity_type === "extracted" && type !== "extracted") {
			db.prepare("UPDATE entities SET entity_type = ? WHERE id = ?").run(type, existing.id);
		}
		return existing.id;
	}
	const id = crypto.randomUUID();
	try {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
		).run(id, trimmed, canonical, type, agentId, now, now);
		return id;
	} catch (err) {
		const row = db.prepare("SELECT id FROM entities WHERE name = ? LIMIT 1").get(trimmed) as { id: string } | undefined;
		if (row) return row.id;
		throw err;
	}
}

const RELATIONSHIP_TYPES = new Set([
	"uses",
	"requires",
	"owned_by",
	"blocks",
	"informs",
	"built",
	"depends_on",
	"related_to",
	"learned_from",
	"teaches",
	"knows",
	"assumes",
	"contradicts",
	"supersedes",
	"part_of",
	"precedes",
	"follows",
	"triggers",
	"impacts",
	"produces",
	"consumes",
]);

function relationshipType(value: string | undefined): string {
	const normalized = (value ?? "related_to")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_");
	return RELATIONSHIP_TYPES.has(normalized) ? normalized : "related_to";
}

function clampNumber(value: unknown, fallback: number): number {
	const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
	if (!Number.isFinite(num)) return fallback;
	return Math.max(0, Math.min(1, num));
}

function persistMappedRelationships(
	db: WriteDb,
	row: KnowledgeSourceRow,
	projection: ReturnType<typeof projectionForRow>,
	mapping: KnowledgeBaseMapping | null | undefined,
	memoryId: string,
	agentId: string,
	now: string,
): number {
	let count = 0;
	for (const rel of mapping?.relationships ?? []) {
		const sourceName = mappedValue(row, rel.sourceField) ?? projection.entityName;
		const targetName = mappedValue(row, rel.targetField);
		if (!targetName) continue;
		const sourceId = upsertMappedEntity(db, sourceName, rel.sourceType ?? projection.entityType, agentId, now);
		const targetId = upsertMappedEntity(db, targetName, rel.targetType ?? "record", agentId, now);
		if (!sourceId || !targetId || sourceId === targetId) continue;
		const depType = relationshipType(rel.type);
		const reason = mappedValue(row, rel.reasonField) ?? `mapped ${depType} relationship from knowledge base record`;
		const existing = db
			.prepare(
				`SELECT id FROM entity_dependencies
				 WHERE source_entity_id = ? AND target_entity_id = ?
				   AND dependency_type = ? AND agent_id = ?
				 LIMIT 1`,
			)
			.get(sourceId, targetId, depType, agentId) as { id: string } | undefined;
		if (existing) {
			db.prepare(
				`UPDATE entity_dependencies
				 SET strength = ?, confidence = ?, reason = ?, updated_at = ?
				 WHERE id = ? AND agent_id = ?`,
			).run(clampNumber(rel.strength, 0.5), clampNumber(rel.confidence, 0.75), reason, now, existing.id, agentId);
		} else {
			db.prepare(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type,
				  strength, confidence, reason, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				crypto.randomUUID(),
				sourceId,
				targetId,
				agentId,
				depType,
				clampNumber(rel.strength, 0.5),
				clampNumber(rel.confidence, 0.75),
				reason,
				now,
				now,
			);
			count++;
		}
		db.prepare(
			`INSERT OR IGNORE INTO memory_entity_mentions
			 (memory_id, entity_id, mention_text, confidence, created_at)
			 VALUES (?, ?, ?, 0.8, ?), (?, ?, ?, 0.8, ?)`,
		).run(memoryId, sourceId, sourceName, now, memoryId, targetId, targetName, now);
	}
	return count;
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

export async function ingestKnowledgeBaseRows(input: KnowledgeBaseIngestInput): Promise<KnowledgeBaseIngestResult> {
	const now = input.now ?? new Date().toISOString();
	let imported = 0;
	let skipped = 0;
	let embedded = 0;
	let attributes = 0;
	let relationships = 0;
	const errors: string[] = [];

	for (const row of input.rows) {
		try {
			const sourceKey = row.sourceKey;
			const recordId = buildSourceRecordId(input.knowledgeBaseId, sourceKey);
			const sourceHash = hashSourceContent(row.content);
			const projection = projectionForRow(input.name, input.kind, row, input.mapping);
			const memoryContent = `[Knowledge base: ${input.name}]\n[Source: ${sourceKey}]\n\n${mappedContent(row, input.mapping)}`;
			const normalized = normalizeAndHashContent(memoryContent);
			const memoryId = crypto.randomUUID();

			const inserted = getDbAccessor().withWriteTx((db) => {
				const existing = db
					.prepare(
						"SELECT memory_id, source_hash FROM knowledge_base_records WHERE knowledge_base_id = ? AND source_key = ?",
					)
					.get(input.knowledgeBaseId, sourceKey) as { memory_id: string | null; source_hash: string } | undefined;
				if (existing?.source_hash === sourceHash && existing.memory_id) return false;

				txIngestEnvelope(db, {
					id: memoryId,
					content: normalized.storageContent,
					normalizedContent: normalized.normalizedContent,
					contentHash: normalized.contentHash,
					who: `knowledge-base:${input.name}`,
					why: input.actor,
					project: null,
					importance: 0.55,
					type: "knowledge_base_record",
					tags: `knowledge-base,knowledge-base:${input.name},${input.kind}`,
					pinned: 0,
					isDeleted: 0,
					extractionStatus: "complete",
					extractionModel: "knowledge-base-import",
					updatedBy: input.actor,
					sourceType: "knowledge_base",
					sourceId: `${input.knowledgeBaseId}:${sourceKey}`,
					knowledgeBaseId: input.knowledgeBaseId,
					knowledgeBaseRecordId: recordId,
					agentId: input.agentId,
					visibility: "global",
					createdAt: now,
				});

				db.prepare(
					`INSERT INTO knowledge_base_records
					 (id, knowledge_base_id, source_kind, source_uri, source_key, source_hash,
					  content, metadata_json, status, memory_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
					 ON CONFLICT(knowledge_base_id, source_key) DO UPDATE SET
					   source_kind = excluded.source_kind,
					   source_uri = excluded.source_uri,
					   source_hash = excluded.source_hash,
					   content = excluded.content,
					   metadata_json = excluded.metadata_json,
					   status = 'active',
					   memory_id = excluded.memory_id,
					   updated_at = excluded.updated_at`,
				).run(
					recordId,
					input.knowledgeBaseId,
					input.kind,
					rowSourceUri(row, input.sourceUri),
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
					agentId: input.agentId,
					now,
				});
				attributes += structured.attributesCreated;
				relationships += persistMappedRelationships(db, row, projection, input.mapping, memoryId, input.agentId, now);

				const hintStmt = db.prepare(
					`INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
					 VALUES (?, ?, ?, ?, ?)`,
				);
				for (const hint of projection.hints) {
					const h = hint.trim();
					if (h.length >= 5 && h.length <= 300) hintStmt.run(crypto.randomUUID(), memoryId, input.agentId, h, now);
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
			input.knowledgeBaseId,
		);
	});

	return { imported, skipped, embedded, attributes, relationships, errors };
}

export function tombstoneMissingKnowledgeBaseRecords(
	knowledgeBaseId: string,
	activeSourceKeys: ReadonlySet<string>,
	now = new Date().toISOString(),
): number {
	return getDbAccessor().withWriteTx((db) => {
		const rows = db
			.prepare("SELECT source_key FROM knowledge_base_records WHERE knowledge_base_id = ? AND status = 'active'")
			.all(knowledgeBaseId) as Array<{ source_key: string }>;
		let changed = 0;
		for (const row of rows) {
			if (activeSourceKeys.has(row.source_key)) continue;
			db.prepare(
				"UPDATE knowledge_base_records SET status = 'tombstoned', updated_at = ? WHERE knowledge_base_id = ? AND source_key = ?",
			).run(now, knowledgeBaseId, row.source_key);
			changed++;
		}
		return changed;
	});
}
