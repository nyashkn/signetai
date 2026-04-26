import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { listActiveSessionRegistry, markSessionRegistryEnded, upsertSessionRegistry } from "./session-registry";

let root = "";
const originalSignetPath = process.env.SIGNET_PATH;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "signet-session-registry-"));
	mkdirSync(join(root, "memory"), { recursive: true });
	process.env.SIGNET_PATH = root;
	initDbAccessor(join(root, "memory", "memories.db"), { agentsDir: root });
});

afterEach(() => {
	closeDbAccessor();
	rmSync(root, { recursive: true, force: true });
	if (originalSignetPath === undefined) {
		Reflect.deleteProperty(process.env, "SIGNET_PATH");
	} else {
		process.env.SIGNET_PATH = originalSignetPath;
	}
});

describe("session registry", () => {
	test("keeps active sessions durable and removes ended sessions from live listings", () => {
		const active = upsertSessionRegistry({
			agentId: "default",
			sessionKey: "sess-live",
			harness: "hermes-agent",
			project: "/repo",
			runtimePath: "plugin",
		});

		expect(active?.appLabel).toBe("Hermes Agent");
		expect(active?.transcriptPath).toBe("memory/hermes-agent/transcripts/transcript.jsonl");
		expect(listActiveSessionRegistry({ agentId: "default", includeSelf: true })).toHaveLength(1);

		const ended = markSessionRegistryEnded({
			agentId: "default",
			sessionKey: "sess-live",
			harness: "hermes-agent",
			project: "/repo",
			runtimePath: "plugin",
			reason: "session-end",
		});

		expect(ended?.status).toBe("ended");
		expect(ended?.endReason).toBe("session-end");
		expect(listActiveSessionRegistry({ agentId: "default", includeSelf: true })).toHaveLength(0);
	});

	test("lists same-agent peer sessions while excluding the current session", () => {
		upsertSessionRegistry({
			agentId: "default",
			sessionKey: "current",
			harness: "codex",
			project: "/repo",
		});
		upsertSessionRegistry({
			agentId: "default",
			sessionKey: "other",
			harness: "claude-code",
			project: "/repo",
		});
		upsertSessionRegistry({
			agentId: "other-agent",
			sessionKey: "other-agent-session",
			harness: "opencode",
			project: "/repo",
		});

		const peers = listActiveSessionRegistry({
			agentId: "default",
			sessionKey: "current",
			harness: "codex",
			includeSelf: false,
		});

		expect(peers.map((peer) => peer.sessionKey)).toEqual(["other"]);
	});

	test("tracks and ends sessions that only provide sessionId", () => {
		const active = upsertSessionRegistry({
			agentId: "default",
			sessionId: "stable-session-id",
			harness: "codex",
		});

		expect(active?.sessionKey).toBeNull();
		expect(active?.sessionId).toBe("stable-session-id");
		expect(listActiveSessionRegistry({ agentId: "default", includeSelf: true })).toHaveLength(1);

		const ended = markSessionRegistryEnded({
			agentId: "default",
			sessionId: "stable-session-id",
			harness: "codex",
		});

		expect(ended?.status).toBe("ended");
		expect(ended?.sessionKey).toBeNull();
		expect(ended?.sessionId).toBe("stable-session-id");
		expect(listActiveSessionRegistry({ agentId: "default", includeSelf: true })).toHaveLength(0);
	});

	test("keeps sessionKey-only and sessionId-only identities distinct", () => {
		const byKey = upsertSessionRegistry({
			agentId: "default",
			sessionKey: "same-token",
			harness: "codex",
		});
		const byId = upsertSessionRegistry({
			agentId: "default",
			sessionId: "same-token",
			harness: "codex",
		});

		expect(byKey?.id).not.toBe(byId?.id);
		expect(listActiveSessionRegistry({ agentId: "default", includeSelf: true })).toHaveLength(2);

		markSessionRegistryEnded({
			agentId: "default",
			sessionKey: "same-token",
			harness: "codex",
		});

		const remaining = listActiveSessionRegistry({ agentId: "default", includeSelf: true });
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.sessionKey).toBeNull();
		expect(remaining[0]?.sessionId).toBe("same-token");
	});

	test("does not truncate explicit large live-session listings", () => {
		for (let index = 0; index < 205; index++) {
			upsertSessionRegistry({
				agentId: "default",
				sessionKey: `session-${index}`,
				harness: "codex",
			});
		}

		expect(
			listActiveSessionRegistry({ agentId: "default", includeSelf: true, limit: Number.MAX_SAFE_INTEGER }),
		).toHaveLength(205);
	});

	test("backfills a later sessionId without losing the canonical sessionKey", () => {
		upsertSessionRegistry({
			agentId: "default",
			sessionKey: "stable-key",
			harness: "claude-code",
		});

		const ended = markSessionRegistryEnded({
			agentId: "default",
			sessionKey: "stable-key",
			sessionId: "stable-id",
			harness: "claude-code",
		});

		expect(ended?.sessionKey).toBe("stable-key");
		expect(ended?.sessionId).toBe("stable-id");
		expect(ended?.status).toBe("ended");
	});

	test("merges a sessionId-only row when the canonical sessionKey arrives later", () => {
		const byId = upsertSessionRegistry({
			agentId: "default",
			sessionId: "stable-id",
			harness: "claude-code",
		});

		const byKeyAndId = upsertSessionRegistry({
			agentId: "default",
			sessionKey: "stable-key",
			sessionId: "stable-id",
			harness: "claude-code",
		});

		expect(byKeyAndId?.id).toBe(byId?.id);
		expect(byKeyAndId?.sessionKey).toBe("stable-key");
		expect(byKeyAndId?.sessionId).toBe("stable-id");
		expect(listActiveSessionRegistry({ agentId: "default", includeSelf: true })).toHaveLength(1);
	});

	test("merges split key and id rows when a later hook reports both identities", () => {
		upsertSessionRegistry({
			agentId: "default",
			sessionKey: "stable-key",
			harness: "claude-code",
		});
		upsertSessionRegistry({
			agentId: "default",
			sessionId: "stable-id",
			harness: "claude-code",
		});

		const ended = markSessionRegistryEnded({
			agentId: "default",
			sessionKey: "stable-key",
			sessionId: "stable-id",
			harness: "claude-code",
		});

		expect(ended?.sessionKey).toBe("stable-key");
		expect(ended?.sessionId).toBe("stable-id");
		expect(ended?.status).toBe("ended");
		expect(listActiveSessionRegistry({ agentId: "default", includeSelf: true })).toHaveLength(0);
	});

	test("does not exclude same-token peers from other harnesses", () => {
		upsertSessionRegistry({
			agentId: "default",
			sessionKey: "same-token",
			harness: "codex",
		});
		upsertSessionRegistry({
			agentId: "default",
			sessionKey: "same-token",
			harness: "claude-code",
		});

		const peers = listActiveSessionRegistry({
			agentId: "default",
			sessionKey: "same-token",
			harness: "codex",
			includeSelf: false,
		});

		expect(peers).toHaveLength(1);
		expect(peers[0]?.harness).toBe("claude-code");
	});

	test("does not globally exclude same-token peers when caller omits harness", () => {
		upsertSessionRegistry({
			agentId: "default",
			sessionKey: "same-token",
			harness: "codex",
		});
		upsertSessionRegistry({
			agentId: "default",
			sessionKey: "same-token",
			harness: "claude-code",
		});

		const peers = listActiveSessionRegistry({
			agentId: "default",
			sessionKey: "same-token",
			includeSelf: false,
		});

		expect(peers.map((peer) => peer.harness).sort()).toEqual(["claude-code", "codex"]);
	});
});
