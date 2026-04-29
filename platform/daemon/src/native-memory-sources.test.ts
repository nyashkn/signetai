import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	claudeCodeNativeMemorySource,
	codexNativeMemorySource,
	indexNativeMemoryFile,
	removeNativeMemoryFile,
	startNativeMemoryBridge,
} from "./native-memory-sources";

describe("native memory sources", () => {
	let dir = "";
	let prevSignetPath: string | undefined;
	let prevSignetAgentId: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-native-memory-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: NativeMemoryTest\n");
		prevSignetPath = process.env.SIGNET_PATH;
		prevSignetAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		if (prevSignetAgentId === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		} else {
			process.env.SIGNET_AGENT_ID = prevSignetAgentId;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("indexes Codex memory artifacts as external artifacts", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories", "rollout_summaries"), { recursive: true });
		const file = join(root, "memories", "rollout_summaries", "2026-04-22-test.md");
		writeFileSync(file, "thread_id: abc\n\nCodex remembered the Hermes bridge decision.\n");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT source_path, source_kind, harness, content FROM memory_artifacts").get() as {
					source_path: string;
					source_kind: string;
					harness: string;
					content: string;
				},
		);
		expect(row.source_path).toBe(file);
		expect(row.source_kind).toBe("native_rollout_summary");
		expect(row.harness).toBe("codex");
		expect(row.content).toContain("Hermes bridge decision");
	});

	it("indexes Codex automation memory files as native artifacts", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "automations", "obsidian-wiki", "memory.md");
		mkdirSync(join(root, "automations", "obsidian-wiki"), { recursive: true });
		writeFileSync(file, "# Automation Memory\n\nThe Obsidian wiki automation processed agent-memory research.\n");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT source_path, source_kind, harness, content FROM memory_artifacts").get() as {
					source_path: string;
					source_kind: string;
					harness: string;
					content: string;
				},
		);
		expect(row.source_path).toBe(file);
		expect(row.source_kind).toBe("native_automation_memory");
		expect(row.harness).toBe("codex");
		expect(row.content).toContain("Obsidian wiki automation");
	});

	it("indexes Claude Code memdir files through the native bridge", async () => {
		const root = join(dir, ".claude");
		const file = join(root, "projects", "repo", "memory", "project-note.md");
		mkdirSync(join(root, "projects", "repo", "memory"), { recursive: true });
		writeFileSync(file, "---\ntype: project\n---\n\nClaude remembered the native memdir contract.\n");

		expect(await indexNativeMemoryFile(claudeCodeNativeMemorySource(root), file)).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT source_path, source_kind, harness, content FROM memory_artifacts").get() as {
					source_path: string;
					source_kind: string;
					harness: string;
					content: string;
				},
		);
		expect(row.source_path).toBe(file);
		expect(row.source_kind).toBe("native_claude_memory");
		expect(row.harness).toBe("claude-code");
		expect(row.content).toContain("native memdir contract");
	});

	it("indexes Claude Code memory index and agent memory files", async () => {
		const root = join(dir, ".claude");
		const indexFile = join(root, "projects", "repo", "memory", "MEMORY.md");
		const agentFile = join(root, "agent-memory", "builder", "preference.md");
		mkdirSync(join(root, "projects", "repo", "memory"), { recursive: true });
		mkdirSync(join(root, "agent-memory", "builder"), { recursive: true });
		writeFileSync(indexFile, "# Memory Index\n\n- [project] project-note.md: contract note\n");
		writeFileSync(agentFile, "Builder agent prefers clean native memory bridges.\n");

		const source = claudeCodeNativeMemorySource(root);
		expect(await indexNativeMemoryFile(source, indexFile)).toBe(true);
		expect(await indexNativeMemoryFile(source, agentFile)).toBe(true);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT source_kind FROM memory_artifacts ORDER BY source_kind").all() as {
					source_kind: string;
				}[],
		);
		expect(rows.map((row) => row.source_kind)).toEqual(["native_claude_agent_memory", "native_claude_memory_index"]);
	});

	it("uses the daemon agent id when no explicit agent id is provided", async () => {
		process.env.SIGNET_AGENT_ID = "agent-native";
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const file = join(root, "memories", "memory_summary.md");
		writeFileSync(file, "Codex remembered a non-default agent preference.\n");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT agent_id FROM memory_artifacts").get() as {
					agent_id: string;
				},
		);
		expect(row.agent_id).toBe("agent-native");
	});

	it("clears the dedupe fingerprint when a native memory file is removed", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memories", "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered the same recreated file.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		removeNativeMemoryFile(source, file, "agent-native");
		writeFileSync(file, "Codex remembered the same recreated file.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts").get() as { count: number },
		).count;
		expect(count).toBe(1);
	});

	it("soft-deletes native memory artifacts when their source file is removed", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "automations", "smoke"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "automations", "smoke", "memory.md");
		writeFileSync(file, "# Smoke\n\nCodex remembered a soft deleted native artifact.\n");

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		removeNativeMemoryFile(source, file, "agent-native");

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as {
					is_deleted: number;
					deleted_at: string | null;
				},
		);
		expect(row.is_deleted).toBe(1);
		expect(row.deleted_at).toBeTruthy();
	});

	it("restores soft-deleted native artifacts when the source file returns", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "automations", "smoke"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "automations", "smoke", "memory.md");
		writeFileSync(file, "# Smoke\n\nCodex remembered a restored native artifact.\n");

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		removeNativeMemoryFile(source, file, "agent-native");
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as {
					is_deleted: number;
					deleted_at: string | null;
				},
		);
		expect(row.is_deleted).toBe(0);
		expect(row.deleted_at).toBeNull();
	});

	it("does not cache a fingerprint when persistence fails", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memories", "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered a retryable persistence failure.\n");
		utimesSync(file, stamp, stamp);

		closeDbAccessor();
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(false);

		initDbAccessor(join(dir, "memory", "memories.db"));
		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
	});

	it("reindexes unchanged native files when the artifact row is missing", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memories", "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered a deleted artifact row.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ? AND source_path = ?").run("agent-native", file);
		});

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		const count = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts").get() as { count: number },
		).count;
		expect(count).toBe(1);
	});

	it("reindexes same-size native files when content changes", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const source = codexNativeMemorySource(root);
		const file = join(root, "memories", "memory_summary.md");
		const stamp = new Date("2026-04-22T12:00:00Z");
		writeFileSync(file, "Codex remembered alpha state.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		writeFileSync(file, "Codex remembered bravo state.\n");
		utimesSync(file, stamp, stamp);

		expect(await indexNativeMemoryFile(source, file, "agent-native")).toBe(true);
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("agent-native", file) as { content: string },
		);
		expect(row.content).toContain("bravo state");
	});

	it("indexes native memories when the source root is created after bridge startup", async () => {
		const root = join(dir, ".codex");
		const handle = startNativeMemoryBridge([codexNativeMemorySource(root)], {
			agentId: "agent-native",
			pollIntervalMs: 25,
		});
		try {
			mkdirSync(join(root, "memories"), { recursive: true });
			const file = join(root, "memories", "memory_summary.md");
			writeFileSync(file, "Codex remembered a late-created native memory root.\n");

			let indexed = false;
			for (let i = 0; i < 20; i++) {
				await Bun.sleep(25);
				const count = getDbAccessor().withReadDb(
					(db) => db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts").get() as { count: number },
				).count;
				if (count > 0) {
					indexed = true;
					break;
				}
			}
			expect(indexed).toBe(true);
		} finally {
			await handle.close();
		}
	});

	it("soft-deletes removed native memories during bridge sync", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "memories", "memory_summary.md");
		mkdirSync(join(root, "memories"), { recursive: true });
		writeFileSync(file, "Codex remembered a native memory that will disappear.\n");

		const handle = startNativeMemoryBridge([codexNativeMemorySource(root)], {
			agentId: "agent-native",
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			rmSync(file);
			expect(await handle.syncExisting()).toBe(0);

			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-native", file) as {
						is_deleted: number;
						deleted_at: string | null;
					},
			);
			expect(row.is_deleted).toBe(1);
			expect(row.deleted_at).toBeTruthy();
		} finally {
			await handle.close();
		}
	});

	it("soft-deletes known native memories when their source root is removed", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "memories", "memory_summary.md");
		mkdirSync(join(root, "memories"), { recursive: true });
		writeFileSync(file, "Codex remembered a native root that will disappear.\n");

		const handle = startNativeMemoryBridge([codexNativeMemorySource(root)], {
			agentId: "agent-native",
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(1);
			rmSync(root, { recursive: true, force: true });
			expect(await handle.syncExisting()).toBe(0);

			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT is_deleted, deleted_at FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("agent-native", file) as {
						is_deleted: number;
						deleted_at: string | null;
					},
			);
			expect(row.is_deleted).toBe(1);
			expect(row.deleted_at).toBeTruthy();
		} finally {
			await handle.close();
		}
	});

	it("keeps known native memory state isolated by source root", async () => {
		const rootA = join(dir, ".codex-a");
		const rootB = join(dir, ".codex-b");
		const fileA = join(rootA, "memories", "memory_summary.md");
		const fileB = join(rootB, "memories", "memory_summary.md");
		mkdirSync(join(rootA, "memories"), { recursive: true });
		mkdirSync(join(rootB, "memories"), { recursive: true });
		writeFileSync(fileA, "Codex remembered source A.\n");
		writeFileSync(fileB, "Codex remembered source B.\n");

		const handle = startNativeMemoryBridge([codexNativeMemorySource(rootA), codexNativeMemorySource(rootB)], {
			agentId: "agent-native",
			pollIntervalMs: 0,
		});
		try {
			expect(await handle.syncExisting()).toBe(2);
			expect(await handle.syncExisting()).toBe(0);

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT source_path, is_deleted FROM memory_artifacts WHERE agent_id = ? ORDER BY source_path")
						.all("agent-native") as Array<{
						source_path: string;
						is_deleted: number;
					}>,
			);
			expect(rows).toEqual([
				{ source_path: fileA, is_deleted: 0 },
				{ source_path: fileB, is_deleted: 0 },
			]);
		} finally {
			await handle.close();
		}
	});

	it("skips nested files below Codex automation memory files", async () => {
		const root = join(dir, ".codex");
		const file = join(root, "automations", "obsidian-wiki", "nested", "memory.md");
		mkdirSync(join(root, "automations", "obsidian-wiki", "nested"), { recursive: true });
		writeFileSync(file, "not a direct automation memory surface");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(false);
	});

	it("skips files outside the declared native memory patterns", async () => {
		const root = join(dir, ".codex");
		mkdirSync(join(root, "memories"), { recursive: true });
		const file = join(root, "memories", "notes.md");
		writeFileSync(file, "not a Codex native memory surface");

		expect(await indexNativeMemoryFile(codexNativeMemorySource(root), file)).toBe(false);
	});
});
