import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HimalayaCommandInput,
	assertSafeAccountName,
	assertSafeMailboxName,
	fetchEmailEnvelopes,
	fetchEmailMessageRaw,
	groupIntoThreads,
	listEmailMailboxes,
	listHimalayaAccounts,
	setHimalayaRunnerForTests,
} from "./email-source-fetch";

afterEach(() => {
	setHimalayaRunnerForTests(null);
});

function stubRunner(output: string): { readonly calls: HimalayaCommandInput[] } {
	const calls: HimalayaCommandInput[] = [];
	setHimalayaRunnerForTests(async (input) => {
		calls.push(input);
		return output;
	});
	return { calls };
}

describe("argument validation", () => {
	test("account and mailbox names that could pass as flags are rejected", () => {
		expect(() => assertSafeAccountName("--config")).toThrow(/Invalid himalaya account name/);
		expect(() => assertSafeAccountName("a; rm -rf /")).toThrow();
		expect(assertSafeAccountName("pivotplanit")).toBe("pivotplanit");
		expect(() => assertSafeMailboxName("-m")).toThrow(/Invalid mailbox name/);
		expect(assertSafeMailboxName("INBOX/Sub Folder")).toBe("INBOX/Sub Folder");
	});

	test("a non-integer uid never reaches the CLI", async () => {
		stubRunner("");
		await expect(fetchEmailMessageRaw({ account: "a", mailbox: "INBOX", uid: 0 })).rejects.toThrow(
			/Invalid message uid/,
		);
	});
});

describe("fetchEmailEnvelopes", () => {
	// Verbatim shape of `himalaya imap fetch --envelope --json` v2.0.0.
	const REAL_OUTPUT = JSON.stringify({
		messages: [
			{
				seq: 177,
				uid: 179,
				flags: null,
				envelope: {
					date: "Sun, 02 Aug 2026 16:43:30 +0000",
					subject: "Sales Cycle Time",
					message_id: "<CAGSSEzrVmDz2cYND044e=sAUe+a3Furb-Q9uvvKn8oN46ES3Ug@mail.gmail.com>",
					in_reply_to: null,
					from: ["Matt West <westmatt81@gmail.com>"],
					sender: ["Matt West <westmatt81@gmail.com>"],
					reply_to: ["Matt West <westmatt81@gmail.com>"],
					to: ["Njui <njui@pivotplanit.com>", "Alecia <alecia.robi@gmail.com>"],
					cc: [],
					bcc: [],
				},
				structure: null,
			},
			{
				seq: 178,
				uid: 186,
				envelope: {
					date: "Mon, 03 Aug 2026 06:15:14 +0000",
					subject: "=?UTF-8?Q?PPC_=26_Attribution?=",
					message_id: "<0100019fc6431caf@email.amazonses.com>",
					in_reply_to: "<CAGSSEzrVmDz2cYND044e=sAUe+a3Furb-Q9uvvKn8oN46ES3Ug@mail.gmail.com>",
					from: ["PivotPlanIt <notifications@tasks.clickup.com>"],
					to: ["njui@pivotplanit.com"],
					cc: [],
				},
			},
		],
	});

	test("maps the ENVELOPE into hard-edge fields and pulls the whole mailbox in one command", async () => {
		const { calls } = stubRunner(REAL_OUTPUT);
		const envelopes = await fetchEmailEnvelopes({ account: "pivotplanit", mailbox: "INBOX" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual([
			"imap",
			"fetch",
			"1:*",
			"--envelope",
			"-m",
			"INBOX",
			"-a",
			"pivotplanit",
			"--json",
		]);

		expect(envelopes[0]).toEqual({
			uid: 179,
			messageId: "<CAGSSEzrVmDz2cYND044e=sAUe+a3Furb-Q9uvvKn8oN46ES3Ug@mail.gmail.com>",
			inReplyTo: "",
			subject: "Sales Cycle Time",
			date: "Sun, 02 Aug 2026 16:43:30 +0000",
			from: [{ name: "Matt West", address: "westmatt81@gmail.com" }],
			to: [
				{ name: "Njui", address: "njui@pivotplanit.com" },
				{ name: "Alecia", address: "alecia.robi@gmail.com" },
			],
			cc: [],
			replyTo: [{ name: "Matt West", address: "westmatt81@gmail.com" }],
		});
	});

	test("decodes encoded subjects and carries in-reply-to through", async () => {
		stubRunner(REAL_OUTPUT);
		const envelopes = await fetchEmailEnvelopes({ account: "pivotplanit", mailbox: "INBOX" });
		expect(envelopes[1]?.subject).toBe("PPC & Attribution");
		expect(envelopes[1]?.inReplyTo).toBe("<CAGSSEzrVmDz2cYND044e=sAUe+a3Furb-Q9uvvKn8oN46ES3Ug@mail.gmail.com>");
	});

	test("malformed rows are skipped rather than failing the sync", async () => {
		stubRunner(JSON.stringify({ messages: [{ seq: 1 }, "junk", { uid: 5 }] }));
		const envelopes = await fetchEmailEnvelopes({ account: "a", mailbox: "INBOX" });
		expect(envelopes).toHaveLength(1);
		expect(envelopes[0]?.uid).toBe(5);
		expect(envelopes[0]?.messageId).toBe("");
	});

	test("non-JSON output is a clear error, not a crash", async () => {
		stubRunner("Error: cannot connect");
		await expect(fetchEmailEnvelopes({ account: "a", mailbox: "INBOX" })).rejects.toThrow(/non-JSON output/);
	});
});

describe("listEmailMailboxes", () => {
	test("returns names from the v2 mailbox list shape", async () => {
		stubRunner(
			JSON.stringify({
				mailboxes: [
					{ id: "Inbox", name: "Inbox", total: null, unread: null },
					{ id: "Sent", name: "Sent" },
					{ id: "broken" },
				],
			}),
		);
		expect(await listEmailMailboxes("pivotplanit")).toEqual(["Inbox", "Sent"]);
	});
});

describe("groupIntoThreads", () => {
	test("walks In-Reply-To to the oldest reachable ancestor", () => {
		const groups = groupIntoThreads([
			{ messageId: "<a>", inReplyTo: "" },
			{ messageId: "<b>", inReplyTo: "<a>" },
			{ messageId: "<c>", inReplyTo: "<b>" },
			{ messageId: "<z>", inReplyTo: "" },
		]);
		expect(groups).toHaveLength(2);
		expect(groups.find((group) => group.rootMessageId === "<a>")?.messageIds).toEqual(["<a>", "<b>", "<c>"]);
		expect(groups.find((group) => group.rootMessageId === "<z>")?.messageIds).toEqual(["<z>"]);
	});

	test("siblings whose shared parent is outside the window still group together", () => {
		const groups = groupIntoThreads([
			{ messageId: "<b>", inReplyTo: "<missing>" },
			{ messageId: "<c>", inReplyTo: "<missing>" },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.rootMessageId).toBe("<missing>");
	});

	test("identical subjects do NOT fuse into one thread", () => {
		// Every ClickUp daily digest shares a subject; fusing them would make the
		// thread tree meaningless, so subject is never a grouping key.
		const groups = groupIntoThreads([
			{ messageId: "<d1>", inReplyTo: "" },
			{ messageId: "<d2>", inReplyTo: "" },
			{ messageId: "<d3>", inReplyTo: "" },
		]);
		expect(groups).toHaveLength(3);
	});

	test("a reply loop terminates instead of hanging", () => {
		const groups = groupIntoThreads([
			{ messageId: "<a>", inReplyTo: "<b>" },
			{ messageId: "<b>", inReplyTo: "<a>" },
		]);
		expect(groups.length).toBeGreaterThan(0);
	});

	test("messages with no Message-ID are dropped, not grouped under an empty key", () => {
		expect(groupIntoThreads([{ messageId: "", inReplyTo: "<a>" }])).toEqual([]);
	});
});

describe("listHimalayaAccounts", () => {
	test("pairs each configured account with the address it authenticates as", async () => {
		// `account list --json` reports names and backends but never an address —
		// this is the verbatim shape from himalaya v2.0.0.
		stubRunner(
			JSON.stringify({
				accounts: [
					{ name: "gmail", default: true, backends: ["imap", "smtp"] },
					{ name: "pivotplanit", default: false, backends: ["imap", "smtp"] },
					{ name: "oauth-only", default: false, backends: ["imap", "smtp"] },
				],
			}),
		);
		const dir = mkdtempSync(join(tmpdir(), "signet-himalaya-config-"));
		const configPath = join(dir, "config.toml");
		writeFileSync(
			configPath,
			[
				"[accounts.gmail]",
				'imap.server = "imaps://imap.gmail.com:993"',
				'imap.sasl.plain.username = "nyashkn@gmail.com"',
				'imap.sasl.plain.password.command = "pass show gmail"',
				"",
				"[accounts.pivotplanit]",
				'imap.sasl.plain.username = "NJUI@pivotplanit.com"',
				'smtp.sasl.plain.username = "njui@pivotplanit.com"',
				"",
				"[accounts.oauth-only]",
				'imap.oauth2.client-id = "abc"',
				"",
				"[other-section]",
				'imap.sasl.plain.username = "not-an-account@example.com"',
				"",
			].join("\n"),
		);

		try {
			const accounts = await listHimalayaAccounts(configPath);
			expect(accounts).toEqual([
				{ name: "gmail", isDefault: true, address: "nyashkn@gmail.com" },
				{ name: "pivotplanit", isDefault: false, address: "njui@pivotplanit.com" },
				// No SASL username to read, so no address is invented for it.
				{ name: "oauth-only", isDefault: false, address: null },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing config yields accounts without addresses rather than throwing", async () => {
		stubRunner(JSON.stringify({ accounts: [{ name: "gmail", default: true }] }));
		const accounts = await listHimalayaAccounts(join(tmpdir(), "signet-no-such-himalaya-config.toml"));
		expect(accounts).toEqual([{ name: "gmail", isDefault: true, address: null }]);
	});
});
