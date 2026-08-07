import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEmailSource } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { setHimalayaRunnerForTests } from "./email-source-fetch";
import { emailSourceProvider } from "./email-source-provider";
import { setPrincipalIdentity } from "./principal-identity";

const HUMAN_ID = "<human-1@mail.gmail.com>";
const REPLY_ID = "<human-2@mail.gmail.com>";
const ROBOT_ID = "<robot-1@email.amazonses.com>";

const ENVELOPES = JSON.stringify({
	messages: [
		{
			uid: 10,
			envelope: {
				date: "Sun, 02 Aug 2026 16:43:30 +0000",
				subject: "Sales Cycle Time",
				message_id: HUMAN_ID,
				in_reply_to: null,
				from: ["Matt West <westmatt81@gmail.com>"],
				to: ["Njui <njui@pivotplanit.com>", "Alecia <alecia.robi@gmail.com>"],
				cc: ["Russ Watts <russ@44watts.com>"],
			},
		},
		{
			uid: 11,
			envelope: {
				date: "Sun, 02 Aug 2026 18:00:00 +0000",
				subject: "Re: Sales Cycle Time",
				message_id: REPLY_ID,
				in_reply_to: HUMAN_ID,
				from: ["Alecia <alecia.robi@gmail.com>"],
				to: ["Matt West <westmatt81@gmail.com>"],
				cc: [],
			},
		},
		{
			uid: 12,
			envelope: {
				date: "Mon, 03 Aug 2026 06:15:14 +0000",
				subject: "Daily Summary | PivotPlanIt",
				message_id: ROBOT_ID,
				in_reply_to: null,
				from: ["PivotPlanIt <notifications@tasks.clickup.com>"],
				to: ["njui@pivotplanit.com"],
				cc: [],
			},
		},
	],
});

function rawMessage(uid: number): string {
	if (uid === 12) {
		return [
			"From: PivotPlanIt <notifications@tasks.clickup.com>",
			"To: njui@pivotplanit.com",
			"Reply-To: ",
			"Feedback-ID: ::1.us-east-1.abc=:AmazonSES",
			`Message-ID: ${ROBOT_ID}`,
			'Content-Type: text/plain; charset="UTF-8"',
			"",
			"You have 3 tasks due.",
			"",
		].join("\r\n");
	}
	return [
		"From: Matt West <westmatt81@gmail.com>",
		"To: Njui <njui@pivotplanit.com>, Alecia <alecia.robi@gmail.com>",
		"Cc: Russ Watts <russ@44watts.com>",
		`Message-ID: ${uid === 10 ? HUMAN_ID : REPLY_ID}`,
		'Content-Type: text/plain; charset="UTF-8"',
		"",
		"Numbers below.",
		"",
		"On Sun, Aug 2, 2026 at 10:03 PM Mike Eastman <mike@dock-blocks.com>",
		" wrote:",
		"",
		"> Forwarded for visibility",
		"",
	].join("\r\n");
}

describe("email-source-provider", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-email-source-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		setHimalayaRunnerForTests(async (input) => {
			if (input.args[0] === "imap") return ENVELOPES;
			if (input.args[0] === "message") return rawMessage(Number(input.args[2]));
			return "{}";
		});
	});

	afterEach(() => {
		setHimalayaRunnerForTests(null);
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	async function sync(): Promise<{ readonly indexed: number; readonly failures: readonly unknown[] }> {
		const added = addEmailSource(
			{ accounts: ["pivotplanit"], mailboxes: ["Inbox"], maxMessagesPerSync: 50, now: "2026-01-01T00:00:00.000Z" },
			dir,
		);
		if (added.ok === false) throw new Error(added.error);
		const result = await emailSourceProvider.sync?.({
			source: added.source,
			agentsDir: dir,
			agentId: "default",
			shouldContinue: () => true,
		});
		if (!result) throw new Error("email provider has no sync");
		return result;
	}

	function rows<T>(sql: string, ...args: unknown[]): T[] {
		return getDbAccessor().withReadDb((db) => db.prepare(sql).all(...args)) as T[];
	}

	it("fetches message bodies rather than silently skipping every one", async () => {
		// Regression: `withReadDb` normalizes a missing `.get()` row to null, so the
		// original `row !== undefined` guard was always true and suppressed 100% of
		// body fetches with no error and no failure entry. Only a real database
		// catches this — a mocked accessor returns undefined and passes.
		const result = await sync();
		expect(result.failures).toEqual([]);

		const fetched = rows<{ n: number }>(
			`SELECT COUNT(*) AS n FROM memory_artifacts
			 WHERE source_kind = 'source_email_message' AND json_extract(source_meta_json, '$.bodyFetched') = 1`,
		);
		expect(fetched[0]?.n).toBe(3);

		const bodies = rows<{ content: string }>(
			"SELECT content FROM memory_artifacts WHERE source_kind = 'source_email_message' AND content LIKE '%Numbers below%'",
		);
		expect(bodies.length).toBeGreaterThan(0);
	});

	it("stores captured_at as ISO so email can be ordered against other sources", async () => {
		// Regression: `capturedAt` took the RFC 2822 `Date:` header verbatim while
		// every other connector stored ISO. `captured_at` is TEXT and is ordered as
		// TEXT, so email sorted alphabetically by weekday name. The fixture is
		// enough to prove it: "Mon, 03 Aug" sorts *before* "Sun, 02 Aug", so the
		// newest message came back as the oldest and a cross-source timeline was
		// meaningless — while every row still looked like a perfectly good date.
		await sync();

		const stored = rows<{ captured_at: string }>(
			`SELECT captured_at FROM memory_artifacts
			 WHERE source_kind = 'source_email_message' ORDER BY captured_at ASC`,
		);
		expect(stored.length).toBe(3);
		for (const row of stored) {
			expect(row.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		}

		// Ordering by the stored column must equal true chronological order.
		expect(stored.map((row) => row.captured_at)).toEqual([
			"2026-08-02T16:43:30.000Z",
			"2026-08-02T18:00:00.000Z",
			"2026-08-03T06:15:14.000Z",
		]);
	});

	it("writes author, recipient and cc edges from headers", async () => {
		await sync();
		const edges = rows<{ dependency_type: string; target: string; strength: number }>(
			`SELECT d.dependency_type, e.canonical_name AS target, d.strength
			 FROM entity_dependencies d
			 JOIN entities e ON e.id = d.target_entity_id
			 WHERE d.dependency_type IN ('authored_by', 'addressed_to', 'copied_on')`,
		);
		expect(edges).toContainEqual({ dependency_type: "authored_by", target: "westmatt81@gmail.com", strength: 1 });
		expect(edges).toContainEqual({ dependency_type: "addressed_to", target: "alecia.robi@gmail.com", strength: 1 });
		expect(edges).toContainEqual({ dependency_type: "copied_on", target: "russ@44watts.com", strength: 1 });
	});

	it("recovers a participant named only inside a quoted block, at reduced strength", async () => {
		await sync();
		const quoted = rows<{ strength: number; reason: string }>(
			`SELECT d.strength, d.reason FROM entity_dependencies d
			 JOIN entities e ON e.id = d.target_entity_id
			 WHERE e.canonical_name = 'mike@dock-blocks.com'`,
		);
		expect(quoted.length).toBeGreaterThan(0);
		expect(quoted[0]?.strength).toBe(0.8);
		expect(quoted[0]?.reason).toContain("quoted");
	});

	it("stores machine mail but never promotes its sender to a person", async () => {
		await sync();
		const classes = rows<{ cls: string; n: number }>(
			`SELECT json_extract(source_meta_json, '$.correspondence') AS cls, COUNT(*) AS n
			 FROM memory_artifacts WHERE source_kind = 'source_email_message' GROUP BY cls`,
		);
		expect(classes).toContainEqual({ cls: "notification", n: 1 });
		expect(classes).toContainEqual({ cls: "direct", n: 2 });

		// The notification is still stored and searchable...
		const stored = rows<{ n: number }>("SELECT COUNT(*) AS n FROM memory_artifacts WHERE content LIKE '%3 tasks due%'");
		expect(stored[0]?.n).toBe(1);

		// ...but its sender is not a person, which is the whole point.
		const robots = rows<{ n: number }>(
			"SELECT COUNT(*) AS n FROM entities WHERE canonical_name = 'notifications@tasks.clickup.com'",
		);
		expect(robots[0]?.n).toBe(0);
	});

	it("builds the account/mailbox/thread/message tree and groups a reply with its parent", async () => {
		await sync();
		const kinds = rows<{ source_kind: string; n: number }>(
			"SELECT source_kind, COUNT(*) AS n FROM memory_artifacts GROUP BY source_kind",
		);
		const byKind = new Map(kinds.map((row) => [row.source_kind, row.n]));
		expect(byKind.get("source_email_account")).toBe(1);
		expect(byKind.get("source_email_mailbox")).toBe(1);
		expect(byKind.get("source_email_message")).toBe(3);
		// Two threads, not three: the reply joins its parent via In-Reply-To.
		expect(byKind.get("source_email_thread")).toBe(2);
	});

	it("prefers a declared principal over addresses inferred from traffic", async () => {
		// Without a declaration the connector infers its own addresses from `To:`
		// frequency, and njui@pivotplanit.com clears that threshold here — the
		// robot message comes back tagged `explicitly-addressed`. Declaring a
		// different address has to win, otherwise the operator has no way to
		// correct a wrong guess, and no way to be recognised at all on a mailbox
		// too quiet for any address to clear the threshold.
		setPrincipalIdentity({
			agentId: "default",
			displayName: "KN",
			identities: [{ identifier: "kinyanjui@kuze.ai", kind: "email" }],
		});
		await sync();

		const signals = rows<{ signals: string | null }>(
			`SELECT json_extract(source_meta_json, '$.correspondenceSignals') AS signals
			 FROM memory_artifacts
			 WHERE source_kind = 'source_email_message'
			   AND json_extract(source_meta_json, '$.correspondence') = 'notification'`,
		);
		expect(signals.length).toBe(1);
		expect(signals[0]?.signals ?? "").not.toContain("explicitly-addressed");
	});

	it("re-syncing does not refetch bodies it already stored", async () => {
		await sync();
		let messageReads = 0;
		setHimalayaRunnerForTests(async (input) => {
			if (input.args[0] === "imap") return ENVELOPES;
			messageReads++;
			return rawMessage(Number(input.args[2]));
		});
		await sync();
		expect(messageReads).toBe(0);
	});

	it("re-syncing keeps the bodies it already stored", async () => {
		// The other half of the same behaviour, and the destructive half: skipping
		// the fetch leaves `parsed` null, so the rewrite rendered an empty body and
		// stamped `bodyFetched: false` over a message that was fully stored. A
		// second sync silently reduced the corpus to headers.
		await sync();
		const before = rows<{ source_path: string; content: string }>(
			"SELECT source_path, content FROM memory_artifacts WHERE source_kind = 'source_email_message' ORDER BY source_path",
		);
		expect(before.some((row) => row.content.includes("Numbers below"))).toBe(true);

		await sync();

		const after = rows<{ source_path: string; content: string }>(
			"SELECT source_path, content FROM memory_artifacts WHERE source_kind = 'source_email_message' ORDER BY source_path",
		);
		expect(after).toEqual(before);
		const fetched = rows<{ n: number }>(
			`SELECT COUNT(*) AS n FROM memory_artifacts
			 WHERE source_kind = 'source_email_message' AND json_extract(source_meta_json, '$.bodyFetched') = 1`,
		);
		expect(fetched[0]?.n).toBe(3);
	});

	it("keeps a message the second sync chose not to rewrite", async () => {
		// Skipping the rewrite must not skip marking the path seen: the stale
		// purge deletes anything a sync did not touch, so an untouched-but-live
		// message would be removed as though the mailbox had dropped it.
		await sync();
		await sync();
		const live = rows<{ n: number }>(
			`SELECT COUNT(*) AS n FROM memory_artifacts
			 WHERE source_kind = 'source_email_message' AND COALESCE(is_deleted, 0) = 0`,
		);
		expect(live[0]?.n).toBe(3);
	});
});
