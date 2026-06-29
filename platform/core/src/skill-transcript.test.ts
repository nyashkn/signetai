import { describe, expect, test } from "bun:test";
import { parseCodexTranscriptSkills, parseTranscriptSkills } from "./skill-transcript.js";

const T1 = "2024-01-01T10:00:00.000Z";
const T2 = "2024-01-01T10:00:01.500Z"; // +1500ms
const T3 = "2024-01-01T10:00:03.000Z"; // +3000ms
const T4 = "2024-01-01T10:00:04.000Z";

// Two Skill uses with results + one orphan use (no tool_result → skipped).
const fixture = [
	// assistant: two Skill tool_use blocks
	JSON.stringify({
		type: "assistant",
		timestamp: T1,
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		message: {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "toolu_001", name: "Skill", input: { skill: "my-skill", args: "hello world" } },
				{ type: "tool_use", id: "toolu_002", name: "Skill", input: { name: "other-skill", args: "foo" } },
			],
		},
	}),
	// user: tool_result for toolu_001 (success)
	JSON.stringify({
		type: "user",
		timestamp: T2,
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_001", is_error: false, content: "done" }],
		},
	}),
	// user: tool_result for toolu_002 (error)
	JSON.stringify({
		type: "user",
		timestamp: T3,
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_002", is_error: true, content: "skill failed" }],
		},
	}),
	// assistant: orphan Skill use — no tool_result in this fixture
	JSON.stringify({
		type: "assistant",
		timestamp: T4,
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		message: {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "toolu_003", name: "Skill", input: { skill: "orphan-skill", args: "no result" } },
			],
		},
	}),
].join("\n");

describe("parseTranscriptSkills", () => {
	test("returns two resolved records and one skipped", () => {
		const { records, skipped } = parseTranscriptSkills(fixture);
		expect(records.length).toBe(2);
		expect(skipped).toBe(1);
	});

	test("toolUseId, sessionId, and skillName are populated for resolved calls", () => {
		const { records } = parseTranscriptSkills(fixture);
		const ids = records.map((r) => r.toolUseId).sort();
		expect(ids).toEqual(["toolu_001", "toolu_002"]);
		for (const r of records) {
			expect(r.sessionId).toBe("sess-abc");
			expect(r.skillName.length).toBeGreaterThan(0);
		}
	});

	test("success=true and latency computed for successful call", () => {
		const { records } = parseTranscriptSkills(fixture);
		const r = records.find((rec) => rec.toolUseId === "toolu_001");
		expect(r).toBeDefined();
		if (!r) return;
		expect(r.skillName).toBe("my-skill");
		expect(r.sessionId).toBe("sess-abc");
		expect(r.success).toBe(true);
		expect(r.latencyMs).toBe(1500);
		expect(r.createdAtMs).toBe(Date.parse(T1));
	});

	test("success reflects is_error for failed call", () => {
		const { records } = parseTranscriptSkills(fixture);
		const r = records.find((rec) => rec.toolUseId === "toolu_002");
		expect(r).toBeDefined();
		if (!r) return;
		expect(r.skillName).toBe("other-skill");
		expect(r.success).toBe(false);
	});

	test("skips unparseable lines without throwing", () => {
		const { records, skipped } = parseTranscriptSkills(`${fixture}\nnot-json\n{broken`);
		expect(records.length).toBe(2);
		expect(skipped).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Codex JSONL fixture
// ---------------------------------------------------------------------------

// session_meta provides a cwd that records should inherit when context.cwd absent.
// signet_recall with call_id c001 + matching output (success=true).
// shell call — non-signet, must be ignored.
// signet_source_search with call_id c002 but no output — must be skipped.
// signet_session_search with no call_id — must emit __seq:0, success=true.
const codexFixture = [
	JSON.stringify({ type: "session_meta", payload: { cwd: "/meta/cwd" } }),
	JSON.stringify({
		type: "response_item",
		payload: { type: "function_call", name: "signet_recall", call_id: "c001", arguments: '{"query":"foo"}' },
	}),
	JSON.stringify({
		type: "response_item",
		payload: { type: "function_call_output", call_id: "c001", output: "found", is_error: false },
	}),
	// non-signet — must be ignored entirely
	JSON.stringify({
		type: "response_item",
		payload: { type: "function_call", name: "shell", call_id: "s001", arguments: '{"cmd":"ls"}' },
	}),
	JSON.stringify({
		type: "response_item",
		payload: { type: "function_call_output", call_id: "s001", output: "README.md" },
	}),
	// signet call with call_id but no matching output → skipped
	JSON.stringify({
		type: "response_item",
		payload: { type: "function_call", name: "signet_source_search", call_id: "c002", arguments: '{"query":"bar"}' },
	}),
	// signet call without call_id → synthetic toolUseId
	JSON.stringify({
		type: "response_item",
		payload: { type: "function_call", name: "signet_session_search", arguments: '{"q":"baz"}' },
	}),
].join("\n");

describe("parseCodexTranscriptSkills", () => {
	test("signet call with call_id and output emits one record with skill_name equal to tool name", () => {
		const { records } = parseCodexTranscriptSkills(codexFixture);
		const rec = records.find((r) => r.toolUseId === "c001");
		expect(rec).toBeDefined();
		if (!rec) return;
		expect(rec.skillName).toBe("signet_recall");
		expect(rec.success).toBe(true);
		expect(rec.toolUseId).toBe("c001");
	});

	test("non-signet call (shell) is ignored", () => {
		const { records } = parseCodexTranscriptSkills(codexFixture);
		const shellRec = records.find((r) => r.skillName === "shell");
		expect(shellRec).toBeUndefined();
	});

	test("signet call with call_id but no output increments skipped", () => {
		const { skipped } = parseCodexTranscriptSkills(codexFixture);
		expect(skipped).toBe(1);
	});

	test("signet call without call_id emits record with synthetic toolUseId and success=true", () => {
		const { records } = parseCodexTranscriptSkills(codexFixture);
		const rec = records.find((r) => r.toolUseId === "__seq:0");
		expect(rec).toBeDefined();
		if (!rec) return;
		expect(rec.skillName).toBe("signet_session_search");
		expect(rec.success).toBe(true);
	});

	test("cwd falls back to session_meta value when context.cwd is absent", () => {
		const { records } = parseCodexTranscriptSkills(codexFixture);
		for (const r of records) {
			expect(r.cwd).toBe("/meta/cwd");
		}
	});

	test("injected context.cwd takes precedence over session_meta cwd", () => {
		const { records } = parseCodexTranscriptSkills(codexFixture, { cwd: "/injected/cwd" });
		for (const r of records) {
			expect(r.cwd).toBe("/injected/cwd");
		}
	});

	test("context.sessionId is propagated to all records", () => {
		const { records } = parseCodexTranscriptSkills(codexFixture, { sessionId: "codex-sess-1" });
		for (const r of records) {
			expect(r.sessionId).toBe("codex-sess-1");
		}
	});

	test("latencyMs and createdAtMs are always 0 (no timestamps in Codex transcripts)", () => {
		const { records } = parseCodexTranscriptSkills(codexFixture);
		for (const r of records) {
			expect(r.latencyMs).toBe(0);
			expect(r.createdAtMs).toBe(0);
		}
	});
});
