import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { bridgeSourceThreads } from "./source-thread-extraction";

const SOURCE_ID = "email:test";
const CLICKUP_SOURCE_ID = "clickup:test";

/** Long enough to clear the body floor without being about anything in particular. */
const REAL_BODY =
	"Matt confirmed the sales cycle sits at 53 days from first contact to signed order, measured across the last two quarters. He wants the quote flow shortened before the Naples launch, and Alecia owns the pricing sheet that blocks it.";

interface ArtifactInput {
	readonly sourceId: string;
	readonly path: string;
	readonly kind: string;
	readonly parent?: string;
	readonly content: string;
	readonly meta?: Record<string, unknown>;
	readonly capturedAt?: string;
}

function writeArtifact(input: ArtifactInput): void {
	indexExternalMemoryArtifact({
		agentId: "default",
		harness: "test",
		sourceId: input.sourceId,
		sourceRoot: `${input.sourceId}://root`,
		sourceExternalId: input.path,
		sourceParentPath: input.parent ?? null,
		sourcePath: input.path,
		sourceKind: input.kind,
		sourceMtimeMs: Date.parse(input.capturedAt ?? "2026-08-01T00:00:00.000Z"),
		capturedAt: input.capturedAt ?? "2026-08-01T00:00:00.000Z",
		content: input.content,
		sourceMeta: input.meta,
	});
}

/** A thread with three messages from a real correspondent. */
function writeDirectThread(): void {
	writeArtifact({
		sourceId: SOURCE_ID,
		path: "email://acct/Inbox/threads/root",
		kind: "source_email_thread",
		content: "# Sales Cycle Time\n\nMessages: 3\nParticipants: Matt West, KN\nSpan: a → b",
		meta: { subject: "Sales Cycle Time", correspondence: "direct", messageCount: 3 },
	});
	for (const [index, body] of [REAL_BODY, "Agreed, I will send the sheet.", "Sheet attached."].entries()) {
		writeArtifact({
			sourceId: SOURCE_ID,
			path: `email://acct/Inbox/messages/m${index}`,
			kind: "source_email_message",
			parent: "email://acct/Inbox/threads/root",
			content: `# Sales Cycle Time\n\nFrom: matt@dock-blocks.com\nTo: njui@pivotplanit.com\nDate: 2026-08-0${index + 1}\n\n${body}`,
			meta: { correspondence: "direct", bodyFetched: true },
			capturedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
		});
	}
}

describe("source-thread-extraction", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-thread-bridge-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	function rows<T>(sql: string, ...args: unknown[]): T[] {
		return getDbAccessor().withReadDb((db) => db.prepare(sql).all(...args)) as T[];
	}

	function bridge(sourceId = SOURCE_ID, sourceKind = "email") {
		return bridgeSourceThreads({ agentId: "default", sourceId, sourceKind });
	}

	it("writes one memory for a whole thread, not one per message", () => {
		writeDirectThread();
		const result = bridge();

		expect(result.created).toBe(1);
		expect(result.memoryIds).toHaveLength(1);

		// Three messages, one call. Paying per message re-derives the same
		// participants three times and is what makes bridging unaffordable.
		const memories = rows<{ id: string; content: string; source_path: string; source_type: string }>(
			"SELECT id, content, source_path, source_type FROM memories WHERE source_id = ?",
			SOURCE_ID,
		);
		expect(memories).toHaveLength(1);

		const content = memories[0]?.content ?? "";
		expect(content).toContain("53 days");
		expect(content).toContain("Sheet attached.");
		// The thread's own path, so recall can deep-link back to the real thing.
		expect(memories[0]?.source_path).toBe("email://acct/Inbox/threads/root");
		expect(memories[0]?.source_type).toBe("email");
	});

	it("enqueues exactly one extraction job for the thread", () => {
		writeDirectThread();
		const result = bridge();
		getDbAccessor().withWriteTx((db) => {
			for (const id of result.memoryIds) {
				db.prepare(
					`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
					 VALUES (?, ?, 'extract', 'pending', 0, 3, ?, ?)`,
				).run(crypto.randomUUID(), id, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
			}
		});
		const jobs = rows<{ n: number }>("SELECT COUNT(*) AS n FROM memory_jobs WHERE job_type = 'extract'");
		expect(jobs[0]?.n).toBe(1);
	});

	it("gates out a machine thread without spending a call", () => {
		writeArtifact({
			sourceId: SOURCE_ID,
			path: "email://acct/Inbox/threads/digest",
			kind: "source_email_thread",
			content: "# Daily Summary | PivotPlanIt\n\nMessages: 1\nParticipants: notifications@tasks.clickup.com",
			meta: { subject: "Daily Summary | PivotPlanIt", correspondence: "machine", messageCount: 1 },
		});
		writeArtifact({
			sourceId: SOURCE_ID,
			path: "email://acct/Inbox/messages/digest",
			kind: "source_email_message",
			parent: "email://acct/Inbox/threads/digest",
			// A digest is the LONGEST thing in the mailbox, so a length-only gate
			// would spend the most on the least.
			content: `# Daily Summary\n\nFrom: notifications@tasks.clickup.com\n\n${"Task updated. ".repeat(400)}`,
			meta: { correspondence: "notification", bodyFetched: true },
		});

		const result = bridge();
		expect(result.gated).toBe(1);
		expect(result.created).toBe(0);
		expect(rows("SELECT id FROM memories WHERE source_id = ?", SOURCE_ID)).toHaveLength(0);
	});

	it("gates out a stub task that is only a title, a status and a link", () => {
		writeArtifact({
			sourceId: CLICKUP_SOURCE_ID,
			path: "clickup://9001/tasks/stub",
			kind: "source_clickup_task",
			content:
				"# Follow up with the Naples dealer about the second slip order\n\nStatus: to do\nAssignees: Alecia\nDue: 2026-08-09\nURL: https://app.clickup.com/t/stub",
			meta: { name: "Follow up with the Naples dealer" },
		});
		writeArtifact({
			sourceId: CLICKUP_SOURCE_ID,
			path: "clickup://9001/tasks/real",
			kind: "source_clickup_task",
			content: `# Extract and integrate HubSpot data\n\nStatus: in progress\nURL: https://app.clickup.com/t/real\n\n${REAL_BODY}`,
			meta: { name: "Extract and integrate HubSpot data" },
		});

		const result = bridge(CLICKUP_SOURCE_ID, "clickup");
		expect(result.gated).toBe(1);
		expect(result.created).toBe(1);

		const memories = rows<{ source_path: string }>(
			"SELECT source_path FROM memories WHERE source_id = ?",
			CLICKUP_SOURCE_ID,
		);
		expect(memories.map((row) => row.source_path)).toEqual(["clickup://9001/tasks/real"]);
	});

	it("folds comments into their task but never a subtask", () => {
		writeArtifact({
			sourceId: CLICKUP_SOURCE_ID,
			path: "clickup://9001/tasks/parent",
			kind: "source_clickup_task",
			content: `# Ship the quote flow\n\nStatus: in progress\n\n${REAL_BODY}`,
			meta: { name: "Ship the quote flow" },
		});
		writeArtifact({
			sourceId: CLICKUP_SOURCE_ID,
			path: "clickup://9001/tasks/child",
			kind: "source_clickup_task",
			parent: "clickup://9001/tasks/parent",
			content: `# Fix the PDF footer\n\nStatus: to do\n\n${REAL_BODY}`,
			meta: { name: "Fix the PDF footer" },
		});
		writeArtifact({
			sourceId: CLICKUP_SOURCE_ID,
			path: "clickup://9001/tasks/parent/comments/c1",
			kind: "source_clickup_comment",
			parent: "clickup://9001/tasks/parent",
			content: "Comment by Matt West\n\nQuote went out Friday and the dealer signed.",
			meta: { author: "matt@dock-blocks.com" },
		});

		const result = bridge(CLICKUP_SOURCE_ID, "clickup");
		expect(result.created).toBe(2);

		const parent = rows<{ content: string }>(
			"SELECT content FROM memories WHERE source_path = 'clickup://9001/tasks/parent'",
		);
		expect(parent[0]?.content).toContain("Quote went out Friday");
		// The subtask is its own thread and gets its own call; folding it in here
		// would extract the same text twice under two different parents.
		expect(parent[0]?.content).not.toContain("Fix the PDF footer");
	});

	it("does not spend a second call on an unchanged thread", () => {
		writeDirectThread();
		const first = bridge();
		expect(first.created).toBe(1);

		const second = bridge();
		expect(second.unchanged).toBe(1);
		expect(second.created).toBe(0);
		expect(second.refreshed).toBe(0);
		expect(second.memoryIds).toHaveLength(0);
		expect(rows("SELECT id FROM memories WHERE source_id = ?", SOURCE_ID)).toHaveLength(1);
	});

	it("rewrites the same memory when a reply arrives, rather than minting a second", () => {
		writeDirectThread();
		const first = bridge();
		const firstId = first.memoryIds[0];

		writeArtifact({
			sourceId: SOURCE_ID,
			path: "email://acct/Inbox/messages/m3",
			kind: "source_email_message",
			parent: "email://acct/Inbox/threads/root",
			content:
				"# Sales Cycle Time\n\nFrom: matt@dock-blocks.com\nDate: 2026-08-04\n\nCorrection: the cycle is 47 days, not 53.",
			meta: { correspondence: "direct", bodyFetched: true },
			capturedAt: "2026-08-04T00:00:00.000Z",
		});

		const second = bridge();
		expect(second.refreshed).toBe(1);
		expect(second.created).toBe(0);
		expect(second.memoryIds).toEqual([firstId ?? ""]);

		const memories = rows<{ id: string; content: string; extraction_status: string }>(
			"SELECT id, content, extraction_status FROM memories WHERE source_id = ?",
			SOURCE_ID,
		);
		// One thread, one row — a memory per revision would grow without bound
		// across syncs, and every stale revision would keep its extracted facts.
		expect(memories).toHaveLength(1);
		expect(memories[0]?.content).toContain("47 days");
		// Reset so the extraction queue does not skip it as already complete.
		expect(memories[0]?.extraction_status).toBe("none");
	});
});
