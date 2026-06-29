/**
 * Pure transcript parser for Skill tool_use invocations.
 *
 * Accepts raw JSONL transcript content (no fs calls) so this function is
 * side-effect-free and testable without touching the filesystem.
 *
 * Replicates the pairing logic from scripts/backfill-skill-invocations.ts so
 * the daemon, CLI, and backfill script can share one canonical parser.
 */

export interface ParsedSkillInvocation {
	readonly skillName: string;
	readonly sessionId: string;
	readonly toolUseId: string; // the toolu_… id from the tool_use block
	readonly cwd: string;
	readonly args: string; // sliced to 2000 chars
	readonly success: boolean;
	readonly latencyMs: number; // wall-clock between message timestamps; includes idle gap
	readonly createdAtMs: number; // use.at epoch ms; 0 if unknown
}

interface PendingUse {
	readonly skillName: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly args: string;
	readonly at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMs(ts: unknown): number {
	if (typeof ts !== "string") return 0;
	const n = Date.parse(ts);
	return Number.isFinite(n) ? n : 0;
}

function toStr(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Parse a full JSONL transcript string and extract Skill tool_use invocations.
 *
 * Each Skill `tool_use` block in an `assistant` message is paired with its
 * matching `tool_result` (by `tool_use_id`) in a later `user` message.
 * Invocations with no matching result are counted in `skipped`; no record is
 * emitted for them (avoids fabricating success=true / latency=0).
 *
 * Malformed or unparseable lines are silently skipped — they never throw.
 */
export function parseTranscriptSkills(content: string): { records: ParsedSkillInvocation[]; skipped: number } {
	const uses = new Map<string, PendingUse>();
	const results = new Map<string, { readonly failed: boolean; readonly at: number }>();

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(row)) continue;

		const message = row.message;
		if (!isRecord(message)) continue;
		const contentBlocks = message.content;
		if (!Array.isArray(contentBlocks)) continue;

		const at = toMs(row.timestamp);

		for (const part of contentBlocks) {
			if (!isRecord(part)) continue;

			if (part.type === "tool_use" && part.name === "Skill") {
				const input = isRecord(part.input) ? part.input : {};
				const skillName = toStr(input.skill) || toStr(input.name) || toStr(input.skill_name);
				if (!skillName) continue;
				uses.set(toStr(part.id), {
					skillName,
					sessionId: toStr(row.sessionId),
					cwd: toStr(row.cwd),
					args: toStr(input.args) || JSON.stringify(input),
					at,
				});
			}

			if (part.type === "tool_result") {
				const id = toStr(part.tool_use_id);
				if (id) {
					results.set(id, { failed: part.is_error === true, at });
				}
			}
		}
	}

	let skipped = 0;
	const records: ParsedSkillInvocation[] = [];
	for (const [id, use] of uses) {
		const result = results.get(id);
		if (!result) {
			// No matching tool_result — session may have crashed mid-tool.
			// Skip rather than fabricate success=true, latency=0.
			skipped++;
			continue;
		}
		// latencyMs is wall-clock time between message timestamps; includes any
		// idle/queue gap before the result message — not pure tool exec time.
		const latencyMs = result.at > use.at ? result.at - use.at : 0;
		records.push({
			skillName: use.skillName,
			sessionId: use.sessionId,
			toolUseId: id,
			cwd: use.cwd,
			args: use.args.slice(0, 2000),
			success: !result.failed,
			latencyMs,
			createdAtMs: use.at,
		});
	}

	return { records, skipped };
}

/**
 * Signet MCP tool names that Codex skills instruct the agent to call.
 * Only these are captured — other function_calls (e.g. "shell", "browser") are
 * intentionally ignored to keep skill_invocations signal-rich.
 */
const SIGNET_CODEX_TOOLS = new Set([
	"signet_recall",
	"signet_source_search",
	"signet_session_search",
	"signet_save_note",
]);

/**
 * Parse a Codex JSONL transcript and extract Signet MCP tool invocations.
 *
 * Codex transcripts use a response_item envelope rather than the claude-code
 * message/content-block format. Tool calls appear as:
 *   {"type":"response_item","payload":{"type":"function_call","name":"...","call_id":"...","arguments":"..."}}
 * and results as:
 *   {"type":"response_item","payload":{"type":"function_call_output","call_id":"...","output":...,"is_error"?:bool}}
 * The working directory is in:
 *   {"type":"session_meta","payload":{"cwd":"..."}}
 *
 * Pairing rules:
 *   - call_id present + matching output found → emit record, success = !is_error
 *   - call_id present + no matching output   → skipped++ (avoid fabricating success=true)
 *   - call_id absent (older / fixture format) → emit record, success=true, toolUseId="__seq:N"
 *
 * NOTE: Codex transcripts carry no per-event timestamps. latencyMs and
 * createdAtMs are permanently 0 for every codex-sourced record — callers
 * must not rely on these fields for latency analysis when harness="codex".
 */
export function parseCodexTranscriptSkills(
	content: string,
	context?: { sessionId?: string; cwd?: string },
): { records: ParsedSkillInvocation[]; skipped: number } {
	// cwd sourced from session_meta; overridden by context.cwd if provided.
	let metaCwd = "";

	// call_id → pending function_call (signet tools only)
	const uses = new Map<string, { name: string; args: string }>();
	// call_id → output info
	const outputs = new Map<string, { isError: boolean }>();
	// function_calls that carry no call_id
	const noidCalls: Array<{ name: string; args: string }> = [];

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let row: unknown;
		try {
			row = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(row)) continue;

		if (row.type === "session_meta") {
			const pl = row.payload;
			if (isRecord(pl)) {
				const c = toStr(pl.cwd);
				if (c) metaCwd = c;
			}
			continue;
		}

		if (row.type !== "response_item") continue;
		const payload = row.payload;
		if (!isRecord(payload)) continue;

		if (payload.type === "function_call") {
			const name = toStr(payload.name);
			if (!SIGNET_CODEX_TOOLS.has(name)) continue;
			const callId = toStr(payload.call_id);
			const args = toStr(payload.arguments).slice(0, 2000);
			if (callId) {
				uses.set(callId, { name, args });
			} else {
				noidCalls.push({ name, args });
			}
		} else if (payload.type === "function_call_output") {
			const callId = toStr(payload.call_id);
			if (callId) {
				outputs.set(callId, { isError: payload.is_error === true });
			}
		}
	}

	const sessionId = context?.sessionId ?? "";
	const cwd = context?.cwd ?? metaCwd;

	let skipped = 0;
	const records: ParsedSkillInvocation[] = [];

	// Emit records for calls paired by call_id
	for (const [callId, use] of uses) {
		const output = outputs.get(callId);
		if (!output) {
			// call_id present but no matching output — skip rather than fabricate.
			skipped++;
			continue;
		}
		records.push({
			skillName: use.name,
			sessionId,
			toolUseId: callId,
			cwd,
			args: use.args,
			success: !output.isError,
			// No timestamps in Codex transcripts — always 0.
			latencyMs: 0,
			createdAtMs: 0,
		});
	}

	// Emit records for calls with no call_id using synthetic toolUseIds
	let seqN = 0;
	for (const use of noidCalls) {
		records.push({
			skillName: use.name,
			sessionId,
			toolUseId: `__seq:${seqN}`,
			cwd,
			args: use.args,
			success: true,
			// No timestamps in Codex transcripts — always 0.
			latencyMs: 0,
			createdAtMs: 0,
		});
		seqN++;
	}

	return { records, skipped };
}
