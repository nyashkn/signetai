import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClickUpSource } from "@signet/core";
import { setClickUpRunnerForTests } from "./clickup-source-fetch";
import { clickUpSourceProvider } from "./clickup-source-provider";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { invalidateSecretsCache, putSecret } from "./secrets";
import { deepLinkForArtifact, parseSourceMeta } from "./source-deep-link";

const MATT = { id: 183, username: "Matt West", email: "matt@dock-blocks.com" };
const ALECIA = { id: 184, username: "Alecia", email: "alecia.robi@gmail.com" };
/** A ClickUp automation user: a real member row with no address behind it. */
const BOT = { id: 900, username: "Automations", email: null };

const SPACE = { id: "s1", name: "Delivery" };
const LIST = { id: "l1", name: "Sprint 14" };

const TEAMS = {
	teams: [
		{
			id: "9001",
			name: "PivotPlanIt",
			members: [{ user: MATT }, { user: ALECIA }, { user: BOT }],
		},
	],
};

const TASKS = {
	tasks: [
		{
			id: "abc1",
			name: "Ship the quote flow",
			markdown_description: "Numbers below.",
			status: { status: "in progress" },
			url: "https://app.clickup.com/t/abc1",
			creator: MATT,
			assignees: [ALECIA],
			watchers: [MATT],
			tags: [{ name: "delivery" }],
			parent: null,
			date_created: "1754265600000",
			date_updated: "1754352000000",
			due_date: "1754438400000",
			space: SPACE,
			list: LIST,
		},
		{
			id: "abc2",
			name: "Fix the PDF footer",
			markdown_description: "Footer overlaps the total.",
			status: { status: "to do" },
			url: "https://app.clickup.com/t/abc2",
			creator: ALECIA,
			assignees: [MATT],
			watchers: [],
			parent: "abc1",
			date_created: "1754265600000",
			date_updated: "1754352000000",
			space: SPACE,
			list: LIST,
		},
		{
			id: "abc3",
			name: "Nightly export",
			markdown_description: "Runs at 02:00.",
			status: { status: "to do" },
			url: "https://app.clickup.com/t/abc3",
			creator: BOT,
			assignees: [],
			watchers: [],
			parent: null,
			date_created: "1754265600000",
			date_updated: "1754352000000",
			space: SPACE,
			list: LIST,
		},
	],
	last_page: true,
};

const COMMENTS: Record<string, unknown> = {
	abc1: { comments: [{ id: "c1", comment_text: "Quote went out Friday.", user: MATT, date: "1754352000000" }] },
};

describe("clickup-source-provider", () => {
	let dir = "";
	let previousSignetPath: string | undefined;
	let commentRequests = 0;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "signet-clickup-source-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		invalidateSecretsCache();
		// The real secret path, not a mock: the provider resolves the token ref
		// through `getSecret`, and a stub there would hide a broken tokenRef flow.
		await putSecret("CLICKUP_TEST_TOKEN", "pk_test_123");
		commentRequests = 0;
		setClickUpRunnerForTests(async (input) => {
			if (input.path === "/team") return TEAMS;
			if (input.path.endsWith("/task")) return TASKS;
			const match = /^\/task\/([^/]+)\/comment$/.exec(input.path);
			if (match) {
				commentRequests++;
				return COMMENTS[match[1] ?? ""] ?? { comments: [] };
			}
			return {};
		});
	});

	afterEach(() => {
		setClickUpRunnerForTests(null);
		closeDbAccessor();
		invalidateSecretsCache();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	async function sync(): Promise<{ readonly indexed: number; readonly failures: readonly unknown[] }> {
		const added = addClickUpSource(
			{ tokenRef: "CLICKUP_TEST_TOKEN", teamIds: ["9001"], now: "2026-01-01T00:00:00.000Z" },
			dir,
		);
		if (added.ok === false) throw new Error(added.error);
		const result = await clickUpSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});
		if (!result) throw new Error("clickup provider has no sync");
		return result;
	}

	function rows<T>(sql: string, ...args: unknown[]): T[] {
		return getDbAccessor().withReadDb((db) => db.prepare(sql).all(...args)) as T[];
	}

	it("builds the workspace/space/list/task tree and nests a subtask under its parent", async () => {
		const result = await sync();
		expect(result.failures).toEqual([]);

		const kinds = new Map(
			rows<{ source_kind: string; n: number }>(
				"SELECT source_kind, COUNT(*) AS n FROM memory_artifacts GROUP BY source_kind",
			).map((row) => [row.source_kind, row.n]),
		);
		expect(kinds.get("source_clickup_workspace")).toBe(1);
		expect(kinds.get("source_clickup_space")).toBe(1);
		expect(kinds.get("source_clickup_list")).toBe(1);
		expect(kinds.get("source_clickup_task")).toBe(3);
		expect(kinds.get("source_clickup_comment")).toBe(1);

		// Containment through the parent task, not the list: a subtask read out of
		// its parent's context loses the only thing that explains it.
		const subtask = rows<{ source_parent_path: string }>(
			"SELECT source_parent_path FROM memory_artifacts WHERE source_path = 'clickup://9001/tasks/abc2'",
		);
		expect(subtask[0]?.source_parent_path).toBe("clickup://9001/tasks/abc1");

		const top = rows<{ source_parent_path: string }>(
			"SELECT source_parent_path FROM memory_artifacts WHERE source_path = 'clickup://9001/tasks/abc1'",
		);
		expect(top[0]?.source_parent_path).toBe("clickup://9001/lists/l1");
	});

	it("writes creator, assignee and watcher edges keyed on the member's email", async () => {
		await sync();
		const edges = rows<{ dependency_type: string; target: string; strength: number }>(
			`SELECT d.dependency_type, e.canonical_name AS target, d.strength
			 FROM entity_dependencies d
			 JOIN entities e ON e.id = d.target_entity_id
			 WHERE d.source_path = 'clickup://9001/tasks/abc1'`,
		);
		expect(edges).toContainEqual({ dependency_type: "authored_by", target: "matt@dock-blocks.com", strength: 1 });
		// An assignee is the artifact directed at a person — the literal shape of
		// "activities we've given them to act on".
		expect(edges).toContainEqual({ dependency_type: "addressed_to", target: "alecia.robi@gmail.com", strength: 1 });
		expect(edges).toContainEqual({ dependency_type: "copied_on", target: "matt@dock-blocks.com", strength: 1 });

		const commentAuthor = rows<{ target: string }>(
			`SELECT e.canonical_name AS target FROM entity_dependencies d
			 JOIN entities e ON e.id = d.target_entity_id
			 WHERE d.source_kind = 'source_clickup_comment' AND d.dependency_type = 'authored_by'`,
		);
		expect(commentAuthor).toContainEqual({ target: "matt@dock-blocks.com" });
	});

	it("reuses the entity the email connector already minted for the same address", async () => {
		// The whole reason ClickUp is the second source: one address, two systems.
		// Without keying on email these would be `matt@dock-blocks.com` and
		// `clickup:183`, and no generator could see that they are one person.
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at,
				  source_id, source_kind)
				 VALUES ('from-email', 'matt@dock-blocks.com', 'matt@dock-blocks.com', 'person', 'default', 12,
				         '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'email:abc', 'source_email_message')`,
			).run();
		});

		await sync();

		const matt = rows<{ id: string; n: number }>(
			"SELECT id, COUNT(*) AS n FROM entities WHERE canonical_name = 'matt@dock-blocks.com'",
		);
		expect(matt[0]?.n).toBe(1);
		expect(matt[0]?.id).toBe("from-email");

		const bridged = rows<{ n: number }>(
			`SELECT COUNT(*) AS n FROM entity_dependencies
			 WHERE target_entity_id = 'from-email' AND source_kind LIKE 'source_clickup%'`,
		);
		expect(bridged[0]?.n).toBeGreaterThan(0);
	});

	it("keeps a member with no address as a clickup identity rather than a bare number", async () => {
		await sync();
		const bot = rows<{ canonical_name: string }>(
			"SELECT canonical_name FROM entities WHERE canonical_name LIKE 'clickup:%'",
		);
		expect(bot).toEqual([{ canonical_name: "clickup:900" }]);
		// And never as the number alone, which would collide with anything else
		// that happens to be called "900".
		const bare = rows<{ n: number }>("SELECT COUNT(*) AS n FROM entities WHERE canonical_name = '900'");
		expect(bare[0]?.n).toBe(0);
	});

	it("deep-links a task to the URL the API returned", async () => {
		await sync();
		const task = rows<{ source_kind: string; source_path: string; source_meta_json: string }>(
			"SELECT source_kind, source_path, source_meta_json FROM memory_artifacts WHERE source_path = 'clickup://9001/tasks/abc1'",
		)[0];
		expect(task).toBeDefined();
		expect(
			deepLinkForArtifact({
				sourceKind: task?.source_kind ?? "",
				sourcePath: task?.source_path ?? "",
				meta: parseSourceMeta(task?.source_meta_json),
			}),
		).toBe("https://app.clickup.com/t/abc1");
	});

	it("re-syncing keeps every task and does not trip the ingest gate", async () => {
		await sync();
		const before = rows<{ source_path: string; content: string }>(
			"SELECT source_path, content FROM memory_artifacts WHERE source_kind = 'source_clickup_task' ORDER BY source_path",
		);
		expect(before.length).toBe(3);
		expect(commentRequests).toBe(3);

		await sync();

		const after = rows<{ source_path: string; content: string }>(
			"SELECT source_path, content FROM memory_artifacts WHERE source_kind = 'source_clickup_task' ORDER BY source_path",
		);
		expect(after).toEqual(before);
		const live = rows<{ n: number }>("SELECT COUNT(*) AS n FROM memory_artifacts WHERE COALESCE(is_deleted, 0) = 1");
		expect(live[0]?.n).toBe(0);
	});
});
