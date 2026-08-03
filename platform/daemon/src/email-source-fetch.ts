/**
 * himalaya CLI driver for the email source connector.
 *
 * himalaya is the substrate rather than a bundled IMAP client because the
 * accounts are already authenticated in `~/.config/himalaya/config.toml` —
 * Signet stores no mail credentials and Gmail arrives through the same path as
 * every other provider.
 *
 * The cost model that shapes this file: **himalaya opens one IMAP login per
 * command.** So metadata for an entire mailbox is pulled in a single
 * `imap fetch 1:* --envelope` call, and raw bodies are fetched one login at a
 * time only for messages the sync has never seen.
 */

import { spawn } from "node:child_process";
import { type EmailAddress, decodeMimeWords, parseAddressList, parseMessageIdList } from "./email-message-parse";

const DEFAULT_HIMALAYA_TIMEOUT_MS = 60_000;
/** himalaya account keys and mailbox names both land in argv; keep them from looking like flags. */
const SAFE_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MAILBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/;

export interface EmailEnvelope {
	/** IMAP UID — the fetch handle. Not stable across mailbox recreation, so never used as an artifact key. */
	readonly uid: number;
	/** RFC 5322 Message-ID including angle brackets. Empty when the server returned none. */
	readonly messageId: string;
	readonly inReplyTo: string;
	readonly subject: string;
	readonly date: string;
	readonly from: readonly EmailAddress[];
	readonly to: readonly EmailAddress[];
	readonly cc: readonly EmailAddress[];
	readonly replyTo: readonly EmailAddress[];
}

export interface HimalayaCommandInput {
	readonly args: readonly string[];
	readonly timeoutMs?: number;
}

export type HimalayaRunner = (input: HimalayaCommandInput) => Promise<string>;

let himalayaRunnerOverride: HimalayaRunner | null = null;

/** Test seam — swap the CLI for a fixture without touching a mailbox. */
export function setHimalayaRunnerForTests(runner: HimalayaRunner | null): void {
	himalayaRunnerOverride = runner;
}

function runner(): HimalayaRunner {
	return himalayaRunnerOverride ?? runHimalaya;
}

export function assertSafeAccountName(account: string): string {
	if (!SAFE_ACCOUNT_NAME.test(account)) throw new Error(`Invalid himalaya account name: ${account}`);
	return account;
}

export function assertSafeMailboxName(mailbox: string): string {
	if (!SAFE_MAILBOX_NAME.test(mailbox)) throw new Error(`Invalid mailbox name: ${mailbox}`);
	return mailbox;
}

function runHimalaya(input: HimalayaCommandInput): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = [...input.args];
		const proc = spawn("himalaya", args, { stdio: "pipe", windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGTERM");
			reject(new Error(`himalaya timed out running: himalaya ${args.join(" ")}`));
		}, input.timeoutMs ?? DEFAULT_HIMALAYA_TIMEOUT_MS);
		timer.unref();
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(
				error.message.includes("ENOENT")
					? new Error("himalaya was not found on PATH; install it or disable the email source")
					: error,
			);
		});
		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(`himalaya exited ${code ?? "unknown"}: ${stderr.trim() || stdout.trim()}`));
		});
	});
}

function parseJson(raw: string, context: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		throw new Error(`himalaya returned non-JSON output for ${context}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Address lists arrive from himalaya pre-formatted as `Name <addr>` strings. */
function addresses(value: unknown): readonly EmailAddress[] {
	return parseAddressList(stringArray(value).join(", "));
}

export async function listEmailMailboxes(account: string, timeoutMs?: number): Promise<readonly string[]> {
	const raw = await runner()({
		args: ["mailbox", "list", "-a", assertSafeAccountName(account), "--json"],
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	const parsed = parseJson(raw, "mailbox list");
	if (!isRecord(parsed) || !Array.isArray(parsed.mailboxes)) return [];
	return parsed.mailboxes
		.filter(isRecord)
		.map((mailbox) => (typeof mailbox.name === "string" ? mailbox.name : ""))
		.filter((name) => name.length > 0);
}

export interface FetchEmailEnvelopesInput {
	readonly account: string;
	readonly mailbox: string;
	/** IMAP UID sequence set. Defaults to the whole mailbox — one login, all metadata. */
	readonly sequence?: string;
	readonly timeoutMs?: number;
}

/**
 * Every envelope in a mailbox in a single IMAP session.
 *
 * `imap fetch --envelope` returns the RFC 3501 ENVELOPE, which already carries
 * message-id, in-reply-to, from, to and cc — the entire hard-edge substrate for
 * the graph. `References` is not part of ENVELOPE and is recovered from the raw
 * message when a body is fetched.
 */
export async function fetchEmailEnvelopes(input: FetchEmailEnvelopesInput): Promise<readonly EmailEnvelope[]> {
	const raw = await runner()({
		args: [
			"imap",
			"fetch",
			input.sequence ?? "1:*",
			"--envelope",
			"-m",
			assertSafeMailboxName(input.mailbox),
			"-a",
			assertSafeAccountName(input.account),
			"--json",
		],
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
	});
	const parsed = parseJson(raw, "imap fetch");
	if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return [];
	const out: EmailEnvelope[] = [];
	for (const message of parsed.messages) {
		if (!isRecord(message)) continue;
		const uid = typeof message.uid === "number" ? message.uid : Number.NaN;
		if (!Number.isFinite(uid)) continue;
		const envelope = isRecord(message.envelope) ? message.envelope : {};
		out.push({
			uid,
			messageId: parseMessageIdList(typeof envelope.message_id === "string" ? envelope.message_id : "")[0] ?? "",
			inReplyTo: parseMessageIdList(typeof envelope.in_reply_to === "string" ? envelope.in_reply_to : "")[0] ?? "",
			subject: decodeMimeWords(typeof envelope.subject === "string" ? envelope.subject : ""),
			date: typeof envelope.date === "string" ? envelope.date : "",
			from: addresses(envelope.from),
			to: addresses(envelope.to),
			cc: addresses(envelope.cc),
			replyTo: addresses(envelope.reply_to),
		});
	}
	return out;
}

export interface FetchEmailMessageInput {
	readonly account: string;
	readonly mailbox: string;
	readonly uid: number;
	readonly timeoutMs?: number;
}

/** Raw RFC 5322 bytes for one message. Costs one IMAP login — call only for unseen UIDs. */
export async function fetchEmailMessageRaw(input: FetchEmailMessageInput): Promise<string> {
	if (!Number.isInteger(input.uid) || input.uid <= 0) throw new Error(`Invalid message uid: ${input.uid}`);
	return runner()({
		args: [
			"message",
			"read",
			String(input.uid),
			"-m",
			assertSafeMailboxName(input.mailbox),
			"-a",
			assertSafeAccountName(input.account),
			"--raw",
		],
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
	});
}

export interface EmailThreadGroup {
	/** Message-ID of the oldest reachable ancestor. Falls back to the message's own id when it has no parent. */
	readonly rootMessageId: string;
	readonly messageIds: readonly string[];
}

/**
 * Group messages into threads by walking `In-Reply-To` to the oldest ancestor
 * we can reach.
 *
 * Deliberately no subject-based fallback: subject grouping fuses every
 * `Daily Summary | PivotPlanIt` into one thread, and a wrong merge is far more
 * expensive than a thread that stays split. When a parent lies outside the
 * fetch window its dangling id becomes the root, which still groups siblings
 * correctly without inventing a relationship.
 */
export function groupIntoThreads(
	messages: readonly { readonly messageId: string; readonly inReplyTo: string }[],
): readonly EmailThreadGroup[] {
	const parents = new Map<string, string>();
	for (const message of messages) {
		if (message.messageId.length > 0 && message.inReplyTo.length > 0) {
			parents.set(message.messageId, message.inReplyTo);
		}
	}

	const rootFor = (messageId: string): string => {
		const seen = new Set<string>([messageId]);
		let current = messageId;
		for (;;) {
			const parent = parents.get(current);
			// Stop on a missing parent or a References loop; malformed mail has both.
			if (parent === undefined || seen.has(parent)) return current;
			seen.add(parent);
			current = parent;
		}
	};

	const groups = new Map<string, string[]>();
	for (const message of messages) {
		if (message.messageId.length === 0) continue;
		const root = rootFor(message.messageId);
		const existing = groups.get(root);
		if (existing) existing.push(message.messageId);
		else groups.set(root, [message.messageId]);
	}
	return [...groups].map(([rootMessageId, messageIds]) => ({ rootMessageId, messageIds }));
}
