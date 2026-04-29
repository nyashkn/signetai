import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureCanonicalTranscriptHistory } from "./session-transcripts";
import {
	appendCanonicalTranscriptSnapshotIfMissing,
	appendCanonicalTranscriptTurns,
	canonicalTranscriptPath,
	writeCanonicalTranscriptSnapshot,
} from "./transcript-jsonl";

const roots: string[] = [];

function makeRoot(name: string): string {
	const root = join(tmpdir(), `signet-transcript-jsonl-${name}-${process.pid}-${Date.now()}`);
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("canonical transcript JSONL", () => {
	test("waits for the transcript file lock before writing live turns", async () => {
		const root = makeRoot("lock");
		const path = canonicalTranscriptPath(root, "codex");
		const lock = `${path}.lock`;
		mkdirSync(lock, { recursive: true });

		const moduleUrl = pathToFileURL(fileURLToPath(new URL("./transcript-jsonl.ts", import.meta.url))).href;
		const worker = join(root, "append-worker.mjs");
		writeFileSync(
			worker,
			`
import { appendCanonicalTranscriptTurns } from ${JSON.stringify(moduleUrl)};

await appendCanonicalTranscriptTurns({
  basePath: process.env.TEST_SIGNET_ROOT,
  agentId: "default",
  harness: "codex",
  sessionKey: "locked-session",
  sourceFormat: "live",
  turns: [{ role: "user", content: "queued while lock is held" }],
});
`,
			"utf8",
		);

		const proc = Bun.spawn([process.execPath, worker], {
			env: { ...process.env, TEST_SIGNET_ROOT: root },
			stdout: "pipe",
			stderr: "pipe",
		});

		await Bun.sleep(100);
		expect(existsSync(path)).toBe(false);

		rmSync(lock, { recursive: true, force: true });
		expect(await proc.exited).toBe(0);
		expect(readFileSync(path, "utf8")).toContain("queued while lock is held");
	});

	test("retries legacy markdown backfill after a transient read failure", async () => {
		const root = makeRoot("retry");
		const memoryDir = join(root, "memory");
		const artifact = join(memoryDir, "2026-04-26T00-00-00Z--aaaaaaaaaaaaaaaa--transcript.md");
		mkdirSync(dirname(artifact), { recursive: true });
		writeFileSync(
			artifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				'session_key: "retry-session"',
				'session_id: "retry-session"',
				'captured_at: "2026-04-26T00:00:00.000Z"',
				'project: "/tmp/project"',
				"---",
				"User: legacy hello",
				"Assistant: migrated now",
				"",
			].join("\n"),
			"utf8",
		);

		chmodSync(artifact, 0);
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(existsSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"))).toBe(false);

		chmodSync(artifact, 0o600);
		await ensureCanonicalTranscriptHistory(root, "default");

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		expect(transcript).toContain("legacy hello");
		expect(transcript).toContain("migrated now");
	});

	test("preserves concurrent live appends to the same harness file", async () => {
		const root = makeRoot("concurrent");
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				Promise.resolve().then(() =>
					appendCanonicalTranscriptTurns({
						basePath: root,
						agentId: "default",
						harness: "codex",
						sessionKey: "concurrent-session",
						sourceFormat: "live",
						turns: [{ role: "user", content: `concurrent turn ${index}` }],
					}),
				),
			),
		);

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		for (let index = 0; index < 12; index++) {
			expect(transcript).toContain(`concurrent turn ${index}`);
		}
	});

	test("deduplicates retried live appends for the same trailing turns", async () => {
		const root = makeRoot("dedupe");
		const input = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "retry-live-session",
			sourceFormat: "live" as const,
			turns: [
				{ role: "assistant" as const, content: "same assistant context" },
				{ role: "user" as const, content: "same retried prompt" },
			],
		};

		await appendCanonicalTranscriptTurns(input);
		await appendCanonicalTranscriptTurns(input);

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		expect(transcript.match(/same assistant context/g)?.length).toBe(1);
		expect(transcript.match(/same retried prompt/g)?.length).toBe(1);
	});
});

describe("backfill OOM regression (#587)", () => {
	test("honors scoped persistent markers without suppressing other agents", async () => {
		const root = makeRoot("marker-skip");
		const memDir = join(root, "memory");
		mkdirSync(memDir, { recursive: true });

		writeFileSync(
			join(memDir, ".canonical-transcript-backfill-v1-default.json"),
			JSON.stringify({ version: 1, completed_at: new Date().toISOString(), agent_id: "default" }),
			"utf8",
		);

		const defaultArtifact = join(memDir, "2026-04-28T00-00-00Z--defaultmarker00--transcript.md");
		writeFileSync(
			defaultArtifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				'session_key: "default-marker-session"',
				'session_id: "default-marker-session"',
				'captured_at: "2026-04-28T00:00:00.000Z"',
				'project: "/tmp/project"',
				"---",
				"User: should not appear for default marker",
				"",
			].join("\n"),
			"utf8",
		);

		await ensureCanonicalTranscriptHistory(root, "default");
		expect(existsSync(join(memDir, "codex", "transcripts", "transcript.jsonl"))).toBe(false);

		const otherArtifact = join(memDir, "2026-04-28T00-00-00Z--othermarker000--transcript.md");
		writeFileSync(
			otherArtifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "agent-b"',
				'harness: "codex"',
				'session_key: "other-marker-session"',
				'session_id: "other-marker-session"',
				'captured_at: "2026-04-28T00:00:00.000Z"',
				'project: "/tmp/project"',
				"---",
				"User: other agent still backfills",
				"",
			].join("\n"),
			"utf8",
		);

		await ensureCanonicalTranscriptHistory(root, "agent-b");
		const transcript = readFileSync(join(memDir, "codex", "transcripts", "transcript.jsonl"), "utf8");
		expect(transcript).toContain("other agent still backfills");
	});

	test("does not treat a large invalid JSONL as completed backfill", async () => {
		const root = makeRoot("populated-skip");
		const memDir = join(root, "memory");
		const transcriptsDir = join(memDir, "codex", "transcripts");
		mkdirSync(transcriptsDir, { recursive: true });

		// Simulate a large JSONL from a previous lifecycle
		const jsonlPath = join(transcriptsDir, "transcript.jsonl");
		const fakeRecord = JSON.stringify({
			session_key: "old-session",
			harness: "codex",
			turns: [{ role: "user", content: "x".repeat(500) }],
		});
		// Write >1MB of data
		const lines = Array.from({ length: 2500 }, () => fakeRecord).join("\n");
		writeFileSync(jsonlPath, lines, "utf8");
		expect(statSync(jsonlPath).size).toBeGreaterThan(1024 * 1024);

		// Create a markdown artifact that would be backfilled
		const artifact = join(memDir, "2026-04-28T00-00-00Z--populatedtest00--transcript.md");
		writeFileSync(
			artifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				'session_key: "populated-skip-session"',
				'session_id: "populated-skip-session"',
				'captured_at: "2026-04-28T00:00:00.000Z"',
				'project: "/tmp/project"',
				"---",
				"User: should not be appended to existing JSONL",
				"",
			].join("\n"),
			"utf8",
		);

		await ensureCanonicalTranscriptHistory(root, "default");

		const content = readFileSync(jsonlPath, "utf8");
		expect(content).toContain("should not be appended to existing JSONL");
		expect(existsSync(join(memDir, ".canonical-transcript-backfill-v1-default.json"))).toBe(true);
	});

	test("backfill snapshot appends are idempotent across retries", async () => {
		const root = makeRoot("append-snapshot-if-missing");
		const jsonlPath = canonicalTranscriptPath(root, "codex");

		await appendCanonicalTranscriptSnapshotIfMissing({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "db",
			transcript: "User: first session\nAssistant: first reply",
		});
		const sizeAfterFirst = statSync(jsonlPath).size;
		expect(sizeAfterFirst).toBeGreaterThan(0);

		await appendCanonicalTranscriptSnapshotIfMissing({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "db",
			transcript: "User: first session\nAssistant: first reply",
		});
		expect(statSync(jsonlPath).size).toBe(sizeAfterFirst);

		await appendCanonicalTranscriptSnapshotIfMissing({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-2",
			sourceFormat: "db",
			transcript: "User: second session\nAssistant: second reply",
		});

		const content = readFileSync(jsonlPath, "utf8");
		expect(content.match(/first session/g)?.length).toBe(1);
		expect(content).toContain("first session");
		expect(content).toContain("second session");
	});

	test("full snapshots replace live partial turns for the same session", async () => {
		const root = makeRoot("snapshot-replaces-live");
		const jsonlPath = canonicalTranscriptPath(root, "codex");

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "same prompt" }],
		});

		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "normalized",
			transcript: "User: same prompt\nAssistant: final reply",
		});

		const content = readFileSync(jsonlPath, "utf8");
		expect(content.match(/same prompt/g)?.length).toBe(1);
		expect(content).toContain("final reply");
	});
});
