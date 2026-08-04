/**
 * Bridge indexed source threads into the extraction pipeline.
 *
 * `entities` has held two disjoint populations: deterministic `source_document*`
 * rows written by connectors, and `person`/`project`/`tool` rows written by LLM
 * extraction over `memories`. They share a table and nothing else, because
 * extraction only ever reads `FROM memories` and no connector has ever written
 * one. A ClickUp task describing a decision, its rationale and the three people
 * it blocks on has been fully indexed and fully invisible to the semantic graph.
 *
 * This closes that. A thread — an email thread with its messages, a ClickUp task
 * with its comments — becomes ONE memory carrying the thread's own source
 * provenance, and that memory is enqueued for extraction like any other.
 *
 * One call per thread, never per message. A 7-message thread is one argument,
 * and paying seven times to re-derive the same participants is the cost model
 * that makes bridging unaffordable in the first place.
 */
import { createHash } from "node:crypto";
import { normalizeAndHashContent } from "./content-normalization";
import { type WriteDb, getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { enqueueExtractionJobInTx } from "./pipeline/extraction-queue";
import { txIngestEnvelope } from "./transactions";

// ---------------------------------------------------------------------------
// Container vocabulary
// ---------------------------------------------------------------------------

export interface ThreadContainerSpec {
	/** Artifact kind that owns the thread. */
	readonly containerKind: string;
	/**
	 * Artifact kind of the messages inside it. Named explicitly rather than
	 * "every child": ClickUp nests subtasks under their parent task, and folding
	 * a subtask into its parent's digest would extract it twice.
	 */
	readonly childKind: string;
}

export const THREAD_CONTAINERS: readonly ThreadContainerSpec[] = [
	{ containerKind: "source_email_thread", childKind: "source_email_message" },
	{ containerKind: "source_clickup_task", childKind: "source_clickup_comment" },
];

/**
 * Chars of digest handed to extraction.
 *
 * Not the 12k `extractFactsAndEntities` would accept, and the difference is
 * measured rather than tidy. A reasoning model spends completion budget on
 * thinking before it writes anything: on a 10k-char digest, deepseek-v4-flash
 * burned 2,733 reasoning tokens and then truncated its JSON mid-object at the
 * 4,096-token ceiling, so the extraction parsed to nothing after being paid for.
 * The digest is an input to extraction, not an archive — the artifacts remain
 * the archive — so the cheap fix is to hand over less of it.
 */
const MAX_DIGEST_CHARS = 4_000;

/** Body chars a thread needs before an LLM call is worth making. */
export const MIN_THREAD_BODY_CHARS = 200;

/**
 * Line prefixes this codebase emits itself when rendering an artifact
 * (`writeMessageArtifact`, `writeTaskArtifact`). They are structure, not
 * content: a task that is a title, a status and a URL has nothing to extract,
 * however many characters those lines add up to.
 */
const STRUCTURAL_LINE =
	/^(?:#{1,6}\s|From:|To:|Cc:|Date:|Status:|Assignees:|Watchers:|Due:|Tags:|URL:|Messages:|Participants:|Span:|Comment by |Author:)/;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface ThreadGateInput {
	/**
	 * The connector's own correspondence verdict, already computed at ingest and
	 * stored on the thread artifact. `null` for sources that do not classify.
	 */
	readonly correspondence: string | null;
	readonly bodyChars: number;
}

export interface ThreadGateResult {
	readonly extract: boolean;
	readonly reason: string;
}

/**
 * Decide whether a thread earns an LLM call.
 *
 * This deliberately does NOT call `assessSignificance` from
 * `pipeline/significance-gate.ts`, and the reason is worth stating: that gate is
 * shaped for session transcripts. It counts `Human:`/`Assistant:` turn pairs,
 * which an email thread has none of, and scores novelty against recent
 * `summary_jobs` transcripts, which are coding sessions. Its verdict is an OR
 * across three signals, so every thread would clear the novelty branch against a
 * corpus of unrelated transcripts and be called significant — including the 130
 * machine threads measured in the standing corpus, which is precisely the
 * outcome the gate exists to prevent. It is the same idea (a zero-cost filter
 * before an expensive call) applied to a different input shape.
 *
 * The strongest signal is free and already computed: the email connector
 * classifies every message `direct` / `notification` / `bulk` at ingest, and
 * rolls that up onto the thread. 68% of the measured inbox is machine mail, and
 * a ClickUp daily digest is the longest thing in it — extracting it would be
 * both the most expensive call and the one producing the junk entities.
 */
export function assessThreadSignificance(input: ThreadGateInput): ThreadGateResult {
	if (
		input.correspondence === "machine" ||
		input.correspondence === "notification" ||
		input.correspondence === "bulk"
	) {
		return { extract: false, reason: `correspondence=${input.correspondence}` };
	}
	if (input.bodyChars < MIN_THREAD_BODY_CHARS) {
		return { extract: false, reason: `body=${input.bodyChars}<${MIN_THREAD_BODY_CHARS}` };
	}
	return { extract: true, reason: "passed" };
}

/** Chars left once the lines this codebase generated itself are removed. */
export function threadBodyChars(digest: string): number {
	return digest
		.split("\n")
		.filter((line) => line.trim().length > 0 && !STRUCTURAL_LINE.test(line))
		.join("\n").length;
}

// ---------------------------------------------------------------------------
// Digest assembly
// ---------------------------------------------------------------------------

interface ArtifactRow {
	readonly source_path: string;
	readonly source_kind: string;
	readonly content: string;
	readonly captured_at: string;
	readonly source_meta_json: string | null;
}

export function buildThreadDigest(container: ArtifactRow, children: readonly ArtifactRow[]): string {
	const parts = [container.content.trim()];
	for (const child of children) {
		const body = child.content.trim();
		if (body.length > 0) parts.push(body);
	}
	const joined = parts.join("\n\n---\n\n");
	return joined.length > MAX_DIGEST_CHARS ? `${joined.slice(0, MAX_DIGEST_CHARS)}\n[truncated]` : joined;
}

function metaString(row: ArtifactRow, key: string): string | null {
	if (!row.source_meta_json) return null;
	try {
		const parsed: unknown = JSON.parse(row.source_meta_json);
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = (parsed as Record<string, unknown>)[key];
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function titleFor(container: ArtifactRow): string {
	const subject = metaString(container, "subject") ?? metaString(container, "name");
	if (subject && subject.trim().length > 0) return subject.trim();
	const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(container.content)?.[1];
	return heading?.trim() || container.source_path;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export interface BridgeSourceThreadsInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceKind: string;
	/** Upper bound on LLM calls a single sync may queue. */
	readonly maxThreadsPerSync?: number;
}

export interface BridgeSourceThreadsResult {
	readonly considered: number;
	readonly gated: number;
	/** Threads whose memory was created for the first time. */
	readonly created: number;
	/** Threads whose memory already existed and whose content changed. */
	readonly refreshed: number;
	/** Threads whose memory already existed unchanged — no LLM call. */
	readonly unchanged: number;
	/** Memory ids to enqueue for extraction. */
	readonly memoryIds: readonly string[];
	/** Threads skipped because the per-sync cap was reached. */
	readonly deferred: number;
}

export const DEFAULT_MAX_THREADS_PER_SYNC = 400;

/** `idempotency_key` for a thread's memory — stable across syncs and content edits. */
function threadKey(sourceId: string, threadPath: string): string {
	return `source-thread:${sourceId}:${createHash("sha256").update(threadPath).digest("hex").slice(0, 32)}`;
}

interface ExistingMemoryRow {
	readonly id: string;
	readonly content_hash: string | null;
}

/**
 * Build one memory per significant thread and return the ids that need
 * extraction. Enqueueing is left to the caller so it can go through the
 * daemon's blocked-provider guard rather than writing jobs a dead provider will
 * never drain.
 */
export function bridgeSourceThreads(input: BridgeSourceThreadsInput): BridgeSourceThreadsResult {
	const specs = THREAD_CONTAINERS;
	const cap = input.maxThreadsPerSync ?? DEFAULT_MAX_THREADS_PER_SYNC;
	const now = new Date().toISOString();

	let considered = 0;
	let gated = 0;
	let created = 0;
	let refreshed = 0;
	let unchanged = 0;
	let deferred = 0;
	const memoryIds: string[] = [];

	for (const spec of specs) {
		const containers = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT source_path, source_kind, content, captured_at, source_meta_json
						 FROM memory_artifacts
						 WHERE agent_id = ? AND source_id = ? AND source_kind = ? AND COALESCE(is_deleted, 0) = 0
						 ORDER BY captured_at DESC`,
					)
					.all(input.agentId, input.sourceId, spec.containerKind) as ArtifactRow[],
		);
		if (containers.length === 0) continue;

		for (const container of containers) {
			considered++;
			if (memoryIds.length >= cap) {
				deferred++;
				continue;
			}

			const children = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path, source_kind, content, captured_at, source_meta_json
							 FROM memory_artifacts
							 WHERE agent_id = ? AND source_id = ? AND source_parent_path = ? AND source_kind = ?
							   AND COALESCE(is_deleted, 0) = 0
							 ORDER BY captured_at ASC`,
						)
						.all(input.agentId, input.sourceId, container.source_path, spec.childKind) as ArtifactRow[],
			);

			const digest = buildThreadDigest(container, children);
			const verdict = assessThreadSignificance({
				correspondence: metaString(container, "correspondence"),
				bodyChars: threadBodyChars(digest),
			});
			if (!verdict.extract) {
				gated++;
				continue;
			}

			const outcome = getDbAccessor().withWriteTx((db) =>
				upsertThreadMemory(db, {
					agentId: input.agentId,
					sourceId: input.sourceId,
					sourceKind: input.sourceKind,
					threadPath: container.source_path,
					title: titleFor(container),
					digest,
					capturedAt: container.captured_at || now,
					now,
				}),
			);
			if (outcome.status === "unchanged") {
				unchanged++;
				continue;
			}
			if (outcome.status === "created") created++;
			else refreshed++;
			memoryIds.push(outcome.memoryId);
		}
	}

	logger.info("source-thread", "Bridged source threads into extraction", {
		sourceId: input.sourceId,
		considered,
		gated,
		created,
		refreshed,
		unchanged,
		deferred,
	});

	return { considered, gated, created, refreshed, unchanged, deferred, memoryIds };
}

interface UpsertThreadMemoryInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceKind: string;
	readonly threadPath: string;
	readonly title: string;
	readonly digest: string;
	readonly capturedAt: string;
	readonly now: string;
}

type UpsertOutcome =
	| { readonly status: "created" | "refreshed"; readonly memoryId: string }
	| { readonly status: "unchanged"; readonly memoryId: string };

export function upsertThreadMemory(db: WriteDb, input: UpsertThreadMemoryInput): UpsertOutcome {
	const key = threadKey(input.sourceId, input.threadPath);
	// The digest usually opens with the container's own `# Subject` heading, so
	// prefixing the title unconditionally states it twice — and the model reads
	// the repetition as emphasis on a subject line rather than as formatting.
	const content = input.digest.startsWith(`# ${input.title}`) ? input.digest : `${input.title}\n\n${input.digest}`;
	const { storageContent, normalizedContent, contentHash } = normalizeAndHashContent(content);

	const existing = db
		.prepare(
			`SELECT id, content_hash FROM memories
			 WHERE idempotency_key = ? AND agent_id = ? AND COALESCE(is_deleted, 0) = 0
			 LIMIT 1`,
		)
		.get(key, input.agentId) as ExistingMemoryRow | undefined | null;

	// A thread grows: a reply arrives, a task gets a comment, a status changes.
	// Rewriting the one memory in place keeps a thread to a single row; inserting
	// a fresh one per revision would grow the graph without bound across syncs.
	if (existing) {
		if (existing.content_hash === contentHash) return { status: "unchanged", memoryId: existing.id };
		db.prepare(
			`UPDATE memories
			 SET content = ?, normalized_content = ?, content_hash = ?, extraction_status = 'none',
			     updated_at = ?, updated_by = ?
			 WHERE id = ?`,
		).run(storageContent, normalizedContent, contentHash, input.now, SOURCE_THREAD_UPDATED_BY, existing.id);
		return { status: "refreshed", memoryId: existing.id };
	}

	const id = crypto.randomUUID();
	txIngestEnvelope(db, {
		id,
		content: storageContent,
		normalizedContent,
		contentHash,
		who: input.sourceKind,
		why: `Thread indexed from ${input.sourceKind} source`,
		project: null,
		importance: 0.4,
		type: "fact",
		tags: null,
		pinned: 0,
		extractionStatus: "none",
		// The thread's own path, so recall returns a deep link to the real thing
		// rather than to a memory with no way back.
		sourceType: input.sourceKind,
		sourceId: input.sourceId,
		sourcePath: input.threadPath,
		idempotencyKey: key,
		agentId: input.agentId,
		createdAt: input.capturedAt,
		updatedBy: SOURCE_THREAD_UPDATED_BY,
	});
	return { status: "created", memoryId: id };
}

export const SOURCE_THREAD_UPDATED_BY = "source-thread-bridge";

/** Enqueue inside the same transaction — used where the caller owns the tx. */
export function enqueueThreadExtractionInTx(db: WriteDb, memoryIds: readonly string[]): void {
	for (const memoryId of memoryIds) enqueueExtractionJobInTx(db, memoryId);
}
