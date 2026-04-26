import { createHash } from "node:crypto";
import { type WriteDb, getDbAccessor, hasDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { formatSessionAppLabel } from "./session-apps";
import { canonicalTranscriptRelativePath, sanitizeHarnessPath } from "./transcript-jsonl";

export type SessionRegistryStatus = "active" | "ended" | "stale";

export interface SessionRegistryRecord {
	readonly id: string;
	readonly agentId: string;
	readonly sessionKey: string | null;
	readonly sessionId: string | null;
	readonly harness: string;
	readonly appId: string;
	readonly appLabel: string;
	readonly project: string | null;
	readonly cwd: string | null;
	readonly runtimePath: "plugin" | "legacy" | null;
	readonly provider: string | null;
	readonly status: SessionRegistryStatus;
	readonly startedAt: string;
	readonly lastSeenAt: string;
	readonly endedAt: string | null;
	readonly endReason: string | null;
	readonly transcriptPath: string | null;
}

export interface SessionRegistryInput {
	readonly agentId?: string | null;
	readonly sessionKey?: string | null;
	readonly sessionId?: string | null;
	readonly harness: string;
	readonly project?: string | null;
	readonly cwd?: string | null;
	readonly runtimePath?: "plugin" | "legacy" | null;
	readonly provider?: string | null;
	readonly transcriptPath?: string | null;
}

export interface ListSessionRegistryOptions {
	readonly agentId?: string;
	readonly sessionKey?: string;
	readonly sessionId?: string;
	readonly harness?: string;
	readonly includeSelf?: boolean;
	readonly project?: string;
	readonly limit?: number;
}

const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function stableId(agentId: string, harness: string, sessionKey: string | null, sessionId: string | null): string {
	const identityKind = sessionKey !== null ? "session_key" : "session_id";
	const identityValue = sessionKey ?? sessionId ?? "";
	return createHash("sha256")
		.update([agentId, sanitizeHarnessPath(harness), identityKind, identityValue].join("\0"), "utf8")
		.digest("hex")
		.slice(0, 32);
}

function identity(input: SessionRegistryInput): {
	readonly id: string;
	readonly agentId: string;
	readonly sessionKey: string | null;
	readonly sessionId: string | null;
	readonly harness: string;
	readonly appId: string;
	readonly appLabel: string;
} | null {
	const sessionKey = clean(input.sessionKey);
	const sessionId = clean(input.sessionId);
	if (!sessionKey && !sessionId) return null;
	const agentId = clean(input.agentId) ?? "default";
	const harness = clean(input.harness) ?? "unknown";
	return {
		id: stableId(agentId, harness, sessionKey, sessionId),
		agentId,
		sessionKey,
		sessionId,
		harness,
		appId: sanitizeHarnessPath(harness),
		appLabel: formatSessionAppLabel(harness),
	};
}

type SessionRegistryIdentity = NonNullable<ReturnType<typeof identity>>;

function findMatchingRegistryRows(db: WriteDb, info: SessionRegistryIdentity): Record<string, unknown>[] {
	const matches: string[] = [];
	const args: unknown[] = [info.agentId, info.harness];
	if (info.sessionKey) {
		matches.push("session_key = ?");
		args.push(info.sessionKey);
	}
	if (info.sessionId) {
		matches.push("session_id = ?");
		args.push(info.sessionId);
	}
	if (matches.length === 0) return [];
	args.push(info.id, info.sessionKey ?? "", info.sessionId ?? "");
	return db
		.prepare(
			`SELECT *
			 FROM session_registry
			 WHERE agent_id = ?
			   AND harness = ?
			   AND (${matches.join(" OR ")})
			 ORDER BY CASE
			   WHEN id = ? THEN 0
			   WHEN session_key = ? THEN 1
			   WHEN session_id = ? THEN 2
			   ELSE 3
			 END,
			 last_seen_at DESC`,
		)
		.all(...args)
		.map((row) => row as Record<string, unknown>);
}

function resolveWriteIdentity(db: WriteDb, info: SessionRegistryIdentity): SessionRegistryIdentity {
	const rows = findMatchingRegistryRows(db, info);
	if (rows.length === 0) return info;
	const id = String(rows[0]?.id ?? info.id);
	for (const row of rows.slice(1)) {
		const duplicateId = String(row.id);
		if (duplicateId !== id) {
			db.prepare("DELETE FROM session_registry WHERE id = ?").run(duplicateId);
		}
	}
	return { ...info, id };
}

function registryTableExists(): boolean {
	if (!hasDbAccessor()) return false;
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_registry'").get();
			return row !== undefined;
		});
	} catch {
		return false;
	}
}

function toStatus(value: unknown): SessionRegistryStatus {
	return value === "ended" || value === "stale" ? value : "active";
}

function toRuntimePath(value: unknown): "plugin" | "legacy" | null {
	return value === "plugin" || value === "legacy" ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function rowToRecord(row: Record<string, unknown>): SessionRegistryRecord {
	return {
		id: String(row.id),
		agentId: String(row.agent_id),
		sessionKey: stringOrNull(row.session_key),
		sessionId: stringOrNull(row.session_id),
		harness: String(row.harness),
		appId: String(row.app_id),
		appLabel: String(row.app_label),
		project: stringOrNull(row.project),
		cwd: stringOrNull(row.cwd),
		runtimePath: toRuntimePath(row.runtime_path),
		provider: stringOrNull(row.provider),
		status: toStatus(row.status),
		startedAt: String(row.started_at),
		lastSeenAt: String(row.last_seen_at),
		endedAt: stringOrNull(row.ended_at),
		endReason: stringOrNull(row.end_reason),
		transcriptPath: stringOrNull(row.transcript_path),
	};
}

function expireStaleSessions(nowMs = Date.now()): void {
	if (!registryTableExists()) return;
	const threshold = new Date(nowMs - STALE_AFTER_MS).toISOString();
	const now = new Date(nowMs).toISOString();
	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE session_registry
				 SET status = 'stale',
				     ended_at = COALESCE(ended_at, ?),
				     end_reason = COALESCE(end_reason, 'stale'),
				     updated_at = ?
				 WHERE status = 'active'
				   AND last_seen_at < ?`,
			).run(now, now, threshold);
		});
	} catch (error) {
		logger.warn("session-tracker", "Session registry stale sweep failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function upsertSessionRegistry(input: SessionRegistryInput): SessionRegistryRecord | null {
	const info = identity(input);
	if (!info || !registryTableExists()) return null;
	const now = new Date().toISOString();
	const transcriptPath = clean(input.transcriptPath) ?? canonicalTranscriptRelativePath(info.harness);

	try {
		return getDbAccessor().withWriteTx((db) => {
			const resolved = resolveWriteIdentity(db, info);
			db.prepare(
				`INSERT INTO session_registry (
					id, agent_id, session_key, session_id, harness, app_id, app_label,
					project, cwd, runtime_path, provider, status, started_at, last_seen_at,
					ended_at, end_reason, transcript_path, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					session_key = COALESCE(session_registry.session_key, excluded.session_key),
					session_id = COALESCE(session_registry.session_id, excluded.session_id),
					harness = excluded.harness,
					app_id = excluded.app_id,
					app_label = excluded.app_label,
					project = COALESCE(excluded.project, session_registry.project),
					cwd = COALESCE(excluded.cwd, session_registry.cwd),
					runtime_path = COALESCE(excluded.runtime_path, session_registry.runtime_path),
					provider = COALESCE(excluded.provider, session_registry.provider),
					status = 'active',
					last_seen_at = excluded.last_seen_at,
					ended_at = NULL,
					end_reason = NULL,
					transcript_path = COALESCE(excluded.transcript_path, session_registry.transcript_path),
					updated_at = excluded.updated_at`,
			).run(
				resolved.id,
				resolved.agentId,
				resolved.sessionKey,
				resolved.sessionId,
				resolved.harness,
				resolved.appId,
				resolved.appLabel,
				clean(input.project),
				clean(input.cwd),
				input.runtimePath ?? null,
				clean(input.provider),
				now,
				now,
				transcriptPath,
				now,
			);
			const row = db.prepare("SELECT * FROM session_registry WHERE id = ?").get(resolved.id);
			return row && typeof row === "object" ? rowToRecord(row as Record<string, unknown>) : null;
		});
	} catch (error) {
		logger.warn("session-tracker", "Session registry upsert failed", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey: info.sessionKey,
			sessionId: info.sessionId,
		});
		return null;
	}
}

export function markSessionRegistryEnded(
	input: SessionRegistryInput & { readonly endedAt?: string; readonly reason?: string | null },
): SessionRegistryRecord | null {
	const info = identity(input);
	if (!info || !registryTableExists()) return null;
	const endedAt = clean(input.endedAt) ?? new Date().toISOString();
	const reason = clean(input.reason) ?? "session-end";
	const transcriptPath = clean(input.transcriptPath) ?? canonicalTranscriptRelativePath(info.harness);

	try {
		return getDbAccessor().withWriteTx((db) => {
			const resolved = resolveWriteIdentity(db, info);
			db.prepare(
				`INSERT INTO session_registry (
					id, agent_id, session_key, session_id, harness, app_id, app_label,
					project, cwd, runtime_path, provider, status, started_at, last_seen_at,
					ended_at, end_reason, transcript_path, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ended', ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					session_key = COALESCE(session_registry.session_key, excluded.session_key),
					session_id = COALESCE(session_registry.session_id, excluded.session_id),
					harness = excluded.harness,
					app_id = excluded.app_id,
					app_label = excluded.app_label,
					project = COALESCE(excluded.project, session_registry.project),
					cwd = COALESCE(excluded.cwd, session_registry.cwd),
					runtime_path = COALESCE(excluded.runtime_path, session_registry.runtime_path),
					provider = COALESCE(excluded.provider, session_registry.provider),
					status = 'ended',
					last_seen_at = MAX(session_registry.last_seen_at, excluded.last_seen_at),
					ended_at = excluded.ended_at,
					end_reason = excluded.end_reason,
					transcript_path = COALESCE(excluded.transcript_path, session_registry.transcript_path),
					updated_at = excluded.updated_at`,
			).run(
				resolved.id,
				resolved.agentId,
				resolved.sessionKey,
				resolved.sessionId,
				resolved.harness,
				resolved.appId,
				resolved.appLabel,
				clean(input.project),
				clean(input.cwd),
				input.runtimePath ?? null,
				clean(input.provider),
				endedAt,
				endedAt,
				endedAt,
				reason,
				transcriptPath,
				endedAt,
			);
			const row = db.prepare("SELECT * FROM session_registry WHERE id = ?").get(resolved.id);
			return row && typeof row === "object" ? rowToRecord(row as Record<string, unknown>) : null;
		});
	} catch (error) {
		logger.warn("session-tracker", "Session registry end failed", {
			error: error instanceof Error ? error.message : String(error),
			sessionKey: info.sessionKey,
			sessionId: info.sessionId,
		});
		return null;
	}
}

export function listActiveSessionRegistry(options: ListSessionRegistryOptions = {}): SessionRegistryRecord[] {
	if (!registryTableExists()) return [];
	expireStaleSessions();
	const agentId = clean(options.agentId);
	const sessionKey = clean(options.sessionKey);
	const sessionId = clean(options.sessionId);
	const harness = clean(options.harness);
	const project = clean(options.project);
	const includeSelf = options.includeSelf !== false;
	const limit = options.limit && Number.isFinite(options.limit) && options.limit > 0 ? Math.trunc(options.limit) : 50;

	try {
		return getDbAccessor().withReadDb((db) => {
			const parts = ["SELECT * FROM session_registry WHERE status = 'active'"];
			const args: unknown[] = [];
			if (project) {
				parts.push("AND project = ?");
				args.push(project);
			}
			if (agentId) {
				parts.push("AND agent_id = ?");
				args.push(agentId);
			}
			const selfMatches: string[] = [];
			const selfArgs: unknown[] = [];
			if (sessionKey) {
				selfMatches.push("session_key = ?");
				selfArgs.push(sessionKey);
			}
			if (sessionId) {
				selfMatches.push("session_id = ?");
				selfArgs.push(sessionId);
			}
			if (agentId && !includeSelf && harness && selfMatches.length > 0) {
				parts.push(`AND NOT (harness = ? AND (${selfMatches.join(" OR ")}))`);
				args.push(harness, ...selfArgs);
			}
			parts.push("ORDER BY last_seen_at DESC LIMIT ?");
			args.push(limit);
			return db
				.prepare(parts.join("\n"))
				.all(...args)
				.map((row) => rowToRecord(row as Record<string, unknown>));
		});
	} catch (error) {
		logger.warn("session-tracker", "Session registry list failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}
