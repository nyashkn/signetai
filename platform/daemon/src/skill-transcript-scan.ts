import { readFileSync } from "node:fs";
import { parseCodexTranscriptSkills, parseTranscriptSkills } from "@signet/core";
import { logger } from "./logger.js";
import { recordSkillInvocation } from "./skill-invocations";

export function recordSkillsFromTranscript(args: {
	readonly transcriptPath: string;
	readonly harness: string;
	readonly agentId: string;
	readonly origin?: string; // default "scan"
	readonly sessionId?: string;
	readonly cwd?: string;
}): void {
	if (args.transcriptPath.trim().length === 0) return;

	let content: string;
	try {
		content = readFileSync(args.transcriptPath, "utf-8");
	} catch (err) {
		logger.debug("skills", "Transcript read failed (non-fatal)", {
			path: args.transcriptPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	// Fire-and-forget telemetry: this must never throw (callers invoke it from
	// setImmediate, where an uncaught throw would crash the daemon). Guard the
	// parse + record loop so the whole function is throw-proof at the contract.
	try {
		const isCodex = args.harness.trim().toLowerCase() === "codex";
		const { records, skipped } = isCodex
			? parseCodexTranscriptSkills(content, { sessionId: args.sessionId, cwd: args.cwd })
			: parseTranscriptSkills(content);
		const origin = args.origin ?? "scan";

		for (const rec of records) {
			recordSkillInvocation({
				skillName: rec.skillName,
				agentId: args.agentId,
				source: "agent",
				latencyMs: rec.latencyMs,
				success: rec.success,
				harness: args.harness,
				sessionId: rec.sessionId,
				toolUseId: rec.toolUseId,
				cwd: rec.cwd,
				args: rec.args,
				origin,
				createdAt: rec.createdAtMs > 0 ? new Date(rec.createdAtMs).toISOString() : undefined,
			});
		}

		logger.debug("skills", "Transcript skill scan complete", {
			path: args.transcriptPath,
			records: records.length,
			skipped,
		});
	} catch (err) {
		logger.warn("skills", "Transcript skill scan failed (non-fatal)", err instanceof Error ? err : undefined);
	}
}
