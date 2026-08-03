/**
 * Email source connector.
 *
 * Artifact tree, mirroring the Discord and GitHub providers:
 *
 *     source_email_account      pivotplanit
 *      └─ source_email_mailbox   Inbox
 *          └─ source_email_thread   keyed by the oldest reachable In-Reply-To ancestor
 *              └─ source_email_message   full text body -> memory_artifacts
 *
 * What makes this connector different from the two that came before it: every
 * edge it writes is *asserted by the transport*, not inferred. `From`, `To`,
 * `Cc` and `In-Reply-To` are structural RFC 5322 fields, so the resulting
 * `authored_by` / `addressed_to` / `copied_on` / `replies_to` edges carry full
 * strength and need no model in the loop. That is why email is the first source
 * able to populate a people graph at all.
 *
 * Machine mail is *classified*, never dropped. A ClickUp notification is still
 * fetched, stored and searchable; it simply does not mint a person entity,
 * because a graph in which "ClickUp Notifications" is a person is worse than no
 * people graph at all.
 */

import { createHash } from "node:crypto";
import {
	type EmailSourceSettings,
	type SignetSourceEntry,
	type SourceFailureState,
	parseEmailSettings,
} from "@signet/core";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import {
	type CorrespondenceClass,
	type EmailAddress,
	type ParsedEmailMessage,
	classifyCorrespondence,
	extractQuotedParticipants,
	isRobotAddress,
	parseEmailMessage,
} from "./email-message-parse";
import { type EmailEnvelope, fetchEmailEnvelopes, fetchEmailMessageRaw, groupIntoThreads } from "./email-source-fetch";
import { logger } from "./logger";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { indexSourceArtifactStructure, purgeSourceArtifactStructure } from "./source-artifact-graph";
import { type SourceParticipant, indexSourceParticipants } from "./source-participant-graph";
import type { SourceProviderAdapter, SourceProviderSyncContext, SourceProviderSyncResult } from "./source-providers";
import { purgeSourceOwnedRows } from "./source-purge";

const EMAIL_PROVIDER_KIND = "email";
const EMAIL_HARNESS = "email";
/**
 * A participant recovered from a quoted forward block is asserted by the
 * quoting client rather than by the transport, so it enters below full
 * strength and is flagged in its reason. Still deterministic — the client wrote
 * both the name and the address — which is why it is well above the 0.4
 * `inferred` band from migration 036.
 */
const QUOTED_PARTICIPANT_STRENGTH = 0.8;

export const emailSourceProvider: SourceProviderAdapter = {
	kind: "email",
	sync: syncEmailSource,
	purge: (source, agentId) => purgeSourceOwnedRows({ sourceId: source.id, agentId }),
};

interface MailboxTarget {
	readonly account: string;
	readonly mailbox: string;
}

interface MessageRecord {
	readonly envelope: EmailEnvelope;
	readonly parsed: ParsedEmailMessage | null;
	readonly correspondence: CorrespondenceClass;
	readonly correspondenceSignals: readonly string[];
}

async function syncEmailSource(context: SourceProviderSyncContext): Promise<SourceProviderSyncResult> {
	const settings = parseEmailSettings(context.source.providerSettings);
	if (settings.accounts.length === 0) throw new Error("Email source has no himalaya accounts");

	const failures: SourceFailureState[] = [];
	const syncStartedAt = new Date().toISOString();
	const agentId = context.agentId || resolveDaemonAgentId();
	const targets: MailboxTarget[] = settings.accounts.flatMap((account) =>
		settings.mailboxes.map((mailbox) => ({ account, mailbox })),
	);

	let indexed = 0;
	let scanned = 0;
	let bodyBudget = settings.maxMessagesPerSync;

	for (const target of targets) {
		if (!context.shouldContinue()) break;
		const currentPath = mailboxPath(target);
		context.onProgress?.({ scanned, total: targets.length, indexed, currentPath });
		const failuresBefore = failures.length;
		try {
			const result = await syncMailbox(context, settings, agentId, target, bodyBudget, failures);
			indexed += result.indexed;
			bodyBudget -= result.bodiesFetched;
			if (failures.length === failuresBefore) {
				purgeStaleEmailArtifacts(context.source.id, agentId, syncStartedAt, result.seenPaths, target);
			}
		} catch (err) {
			failures.push(
				failureState(context.source, `Email sync failed for ${currentPath}: ${errorMessage(err)}`, {
					account: target.account,
					mailbox: target.mailbox,
				}),
			);
		}
		scanned++;
		context.onProgress?.({ scanned, total: targets.length, indexed, currentPath });
	}

	for (const failure of failures) {
		indexed += writeFailureArtifact(context.source, agentId, failure);
	}
	return { indexed, scanned, total: targets.length, failures };
}

interface MailboxSyncResult {
	readonly indexed: number;
	readonly bodiesFetched: number;
	readonly seenPaths: ReadonlySet<string>;
}

async function syncMailbox(
	context: SourceProviderSyncContext,
	settings: EmailSourceSettings,
	agentId: string,
	target: MailboxTarget,
	bodyBudget: number,
	failures: SourceFailureState[],
): Promise<MailboxSyncResult> {
	// One IMAP login for the entire mailbox. The RFC 3501 ENVELOPE already
	// carries message-id, in-reply-to, from, to and cc, which is the whole
	// hard-edge substrate — bodies are the only thing worth paying per-message
	// logins for.
	const envelopes = await fetchEmailEnvelopes({ account: target.account, mailbox: target.mailbox });
	const sinceMs = settings.since ? Date.parse(settings.since) : Number.NaN;
	const inWindow = Number.isFinite(sinceMs)
		? envelopes.filter((envelope) => (Date.parse(envelope.date) || 0) >= sinceMs)
		: envelopes;

	const ownAddresses = collectOwnAddresses(inWindow);
	const knownMessageIds = new Set(inWindow.map((envelope) => envelope.messageId).filter((id) => id.length > 0));
	const reciprocated = collectReciprocatedAddresses(agentId, context.source.id);

	const seenPaths = new Set<string>();
	const yielder = yieldEvery(5);
	let indexed = 0;
	let bodiesFetched = 0;

	const accountPath = accountArtifactPath(target.account);
	const mailboxPathValue = mailboxPath(target);

	const records: MessageRecord[] = [];
	for (const envelope of inWindow) {
		if (!context.shouldContinue()) break;
		let parsed: ParsedEmailMessage | null = null;
		if (bodiesFetched < bodyBudget && !hasIndexedBody(agentId, context.source.id, messagePath(target, envelope))) {
			try {
				parsed = parseEmailMessage(
					await fetchEmailMessageRaw({ account: target.account, mailbox: target.mailbox, uid: envelope.uid }),
				);
				bodiesFetched++;
			} catch (err) {
				failures.push(
					failureState(context.source, `Email body fetch failed: ${errorMessage(err)}`, {
						account: target.account,
						mailbox: target.mailbox,
						uid: envelope.uid,
					}),
				);
			}
		}
		const verdict = classifyMessage(envelope, parsed, ownAddresses, knownMessageIds, reciprocated);
		records.push({
			envelope,
			parsed,
			correspondence: verdict.class,
			correspondenceSignals: verdict.signals,
		});
		await yielder();
	}

	const byMessageId = new Map(
		records.filter((record) => record.envelope.messageId).map((record) => [record.envelope.messageId, record]),
	);
	const threads = groupIntoThreads(
		records.map((record) => ({ messageId: record.envelope.messageId, inReplyTo: record.envelope.inReplyTo })),
	);

	indexed += writeAccountArtifact(context.source, agentId, target, accountPath, seenPaths);
	indexed += writeMailboxArtifact(context.source, agentId, target, accountPath, mailboxPathValue, seenPaths);

	for (const thread of threads) {
		if (!context.shouldContinue()) break;
		const members = thread.messageIds
			.map((messageId) => byMessageId.get(messageId))
			.filter((record): record is MessageRecord => record !== undefined)
			.sort((left, right) => (Date.parse(left.envelope.date) || 0) - (Date.parse(right.envelope.date) || 0));
		if (members.length === 0) continue;

		const threadPathValue = threadPath(target, thread.rootMessageId);
		indexed += writeThreadArtifact(
			context.source,
			agentId,
			target,
			mailboxPathValue,
			threadPathValue,
			members,
			seenPaths,
		);

		for (const record of members) {
			indexed += writeMessageArtifact(context.source, agentId, settings, target, threadPathValue, record, seenPaths);
		}
		await yielder();
	}

	return { indexed, bodiesFetched, seenPaths };
}

function classifyMessage(
	envelope: EmailEnvelope,
	parsed: ParsedEmailMessage | null,
	ownAddresses: ReadonlySet<string>,
	knownMessageIds: ReadonlySet<string>,
	reciprocated: ReadonlySet<string>,
): { readonly class: CorrespondenceClass; readonly signals: readonly string[] } {
	const senderAddress = envelope.from[0]?.address ?? "";
	const repliesToKnownMessage = envelope.inReplyTo.length > 0 && knownMessageIds.has(envelope.inReplyTo);
	if (parsed) {
		return classifyCorrespondence({
			headers: parsed.headers,
			ownAddresses,
			repliesToKnownMessage,
			reciprocated: reciprocated.has(senderAddress),
		});
	}
	// Body was skipped (budget, or already stored), so `List-Unsubscribe` and the
	// ESP markers cannot be inspected. The sender address still can be, and it is
	// the signal that separates `notifications@` from a colleague — defaulting
	// everything here to `notification` would bury real correspondents in any
	// mailbox larger than the body budget.
	if (reciprocated.has(senderAddress)) return { class: "direct", signals: ["envelope-only", "reciprocated"] };
	if (repliesToKnownMessage) return { class: "direct", signals: ["envelope-only", "reply-chain"] };
	if (senderAddress.length === 0) return { class: "notification", signals: ["envelope-only", "no-sender"] };
	if (isRobotAddress(senderAddress) || envelope.replyTo.some((address) => isRobotAddress(address.address))) {
		return { class: "notification", signals: ["envelope-only", `robot-local-part:${senderAddress}`] };
	}
	return { class: "direct", signals: ["envelope-only", "human-sender-address"] };
}

function collectOwnAddresses(envelopes: readonly EmailEnvelope[]): ReadonlySet<string> {
	// The account's own addresses are whatever it is consistently addressed as.
	// Reading them off the traffic avoids a second himalaya call for account
	// config that would only restate the same thing.
	const counts = new Map<string, number>();
	for (const envelope of envelopes) {
		for (const address of envelope.to) counts.set(address.address, (counts.get(address.address) ?? 0) + 1);
	}
	const threshold = Math.max(2, envelopes.length * 0.2);
	return new Set([...counts].filter(([, count]) => count >= threshold).map(([address]) => address));
}

/** Addresses this source has already recorded us writing *to* — the strongest "this is a real correspondent" signal. */
function collectReciprocatedAddresses(agentId: string, sourceId: string): ReadonlySet<string> {
	try {
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT DISTINCT e.canonical_name AS address
						 FROM entity_dependencies d
						 JOIN entities e ON e.id = d.target_entity_id
						 WHERE d.agent_id = ?
						   AND d.source_id = ?
						   AND d.dependency_type IN ('addressed_to', 'copied_on')
						   AND d.source_path LIKE '%/Sent/%'`,
					)
					.all(agentId, sourceId) as Array<{ address: string | null }>,
		);
		return new Set(rows.map((row) => (row.address ?? "").toLowerCase()).filter((address) => address.length > 0));
	} catch (err) {
		logger.warn("email-source", "Reciprocity lookup failed; treating every sender as unreciprocated", {
			error: errorMessage(err),
		});
		return new Set();
	}
}

/**
 * Has this message's body already been stored, so the sync can skip paying an
 * IMAP login for it?
 *
 * Counts rather than probing for a row: `withReadDb` normalizes a missing
 * `.get()` result to `null`, so an `!== undefined` check is true even when
 * nothing matched and would silently suppress every body fetch.
 */
function hasIndexedBody(agentId: string, sourceId: string, sourcePath: string): boolean {
	try {
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT COUNT(*) AS n FROM memory_artifacts
						 WHERE agent_id = ? AND source_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0
						   AND json_extract(source_meta_json, '$.bodyFetched') = 1`,
					)
					.get(agentId, sourceId, sourcePath) as { n: number } | null | undefined,
		);
		return (row?.n ?? 0) > 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Artifact writers
// ---------------------------------------------------------------------------

function writeAccountArtifact(
	source: SignetSourceEntry,
	agentId: string,
	target: MailboxTarget,
	path: string,
	seenPaths: Set<string>,
): number {
	if (seenPaths.has(path)) return 0;
	const content = `# Email account ${target.account}`;
	indexExternalMemoryArtifact({
		agentId,
		harness: EMAIL_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `account:${target.account}`,
		sourcePath: path,
		sourceKind: "source_email_account",
		sourceMtimeMs: Date.now(),
		content,
		sourceMeta: { provider: EMAIL_PROVIDER_KIND, account: target.account },
	});
	indexSourceArtifactStructure({
		agentId,
		sourceId: source.id,
		sourceKind: "source_email_account",
		sourceRoot: source.root,
		sourcePath: path,
		displayName: target.account,
		content,
	});
	seenPaths.add(path);
	return 1;
}

function writeMailboxArtifact(
	source: SignetSourceEntry,
	agentId: string,
	target: MailboxTarget,
	accountPath: string,
	path: string,
	seenPaths: Set<string>,
): number {
	if (seenPaths.has(path)) return 0;
	const content = `# ${target.mailbox} (${target.account})`;
	indexExternalMemoryArtifact({
		agentId,
		harness: EMAIL_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `mailbox:${target.account}:${target.mailbox}`,
		sourceParentPath: accountPath,
		sourcePath: path,
		sourceKind: "source_email_mailbox",
		sourceMtimeMs: Date.now(),
		content,
		sourceMeta: { provider: EMAIL_PROVIDER_KIND, account: target.account, mailbox: target.mailbox },
	});
	indexSourceArtifactStructure({
		agentId,
		sourceId: source.id,
		sourceKind: "source_email_mailbox",
		sourceRoot: source.root,
		sourceParentPath: accountPath,
		sourcePath: path,
		displayName: `${target.mailbox} (${target.account})`,
		content,
	});
	seenPaths.add(path);
	return 1;
}

function writeThreadArtifact(
	source: SignetSourceEntry,
	agentId: string,
	target: MailboxTarget,
	mailboxPathValue: string,
	path: string,
	members: readonly MessageRecord[],
	seenPaths: Set<string>,
): number {
	if (seenPaths.has(path)) return 0;
	const first = members[0];
	if (!first) return 0;
	const subject = first.envelope.subject || "(no subject)";
	const participants = uniqueAddresses(members.flatMap((record) => [...record.envelope.from, ...record.envelope.to]));
	const content = [
		`# ${subject}`,
		"",
		`Messages: ${members.length}`,
		`Participants: ${participants.map(formatAddress).join(", ")}`,
		`Span: ${first.envelope.date} → ${members[members.length - 1]?.envelope.date ?? first.envelope.date}`,
	].join("\n");
	indexExternalMemoryArtifact({
		agentId,
		harness: EMAIL_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `thread:${target.account}:${path}`,
		sourceParentPath: mailboxPathValue,
		sourcePath: path,
		sourceKind: "source_email_thread",
		sourceMtimeMs: Date.parse(members[members.length - 1]?.envelope.date ?? "") || Date.now(),
		capturedAt: first.envelope.date,
		content,
		sourceMeta: {
			provider: EMAIL_PROVIDER_KIND,
			account: target.account,
			mailbox: target.mailbox,
			subject,
			messageCount: members.length,
			correspondence: members.some((record) => record.correspondence === "direct") ? "direct" : "machine",
		},
	});
	indexSourceArtifactStructure({
		agentId,
		sourceId: source.id,
		sourceKind: "source_email_thread",
		sourceRoot: source.root,
		sourceParentPath: mailboxPathValue,
		sourcePath: path,
		displayName: subject,
		content,
	});
	seenPaths.add(path);
	return 1;
}

function writeMessageArtifact(
	source: SignetSourceEntry,
	agentId: string,
	settings: EmailSourceSettings,
	target: MailboxTarget,
	threadPathValue: string,
	record: MessageRecord,
	seenPaths: Set<string>,
): number {
	const path = messagePath(target, record.envelope);
	if (seenPaths.has(path)) return 0;
	const { envelope, parsed } = record;
	const body = parsed?.textBody ?? "";
	const content = [
		`# ${envelope.subject || "(no subject)"}`,
		"",
		`From: ${envelope.from.map(formatAddress).join(", ")}`,
		`To: ${envelope.to.map(formatAddress).join(", ")}`,
		envelope.cc.length > 0 ? `Cc: ${envelope.cc.map(formatAddress).join(", ")}` : undefined,
		`Date: ${envelope.date}`,
		"",
		body,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");

	indexExternalMemoryArtifact({
		agentId,
		harness: EMAIL_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: envelope.messageId || `uid:${target.account}:${target.mailbox}:${envelope.uid}`,
		sourceParentPath: threadPathValue,
		sourcePath: path,
		sourceKind: "source_email_message",
		sourceMtimeMs: Date.parse(envelope.date) || Date.now(),
		capturedAt: envelope.date,
		content,
		sourceMeta: {
			provider: EMAIL_PROVIDER_KIND,
			account: target.account,
			mailbox: target.mailbox,
			uid: envelope.uid,
			messageId: envelope.messageId,
			inReplyTo: envelope.inReplyTo,
			references: parsed?.references ?? [],
			subject: envelope.subject,
			from: envelope.from.map((address) => address.address),
			to: envelope.to.map((address) => address.address),
			cc: envelope.cc.map((address) => address.address),
			date: envelope.date,
			// Stored rather than applied destructively: reclassifying later is a
			// local recompute over these fields, with no refetch and no re-login.
			correspondence: record.correspondence,
			correspondenceSignals: record.correspondenceSignals,
			bodyFetched: parsed !== null,
		},
	});
	const structure = indexSourceArtifactStructure({
		agentId,
		sourceId: source.id,
		sourceKind: "source_email_message",
		sourceRoot: source.root,
		sourceParentPath: threadPathValue,
		sourcePath: path,
		displayName: envelope.subject || `Message ${envelope.uid}`,
		content,
	});

	const participants = buildParticipants(record, settings);
	if (participants.length > 0) {
		const result = indexSourceParticipants({
			agentId,
			sourceId: source.id,
			sourceKind: "source_email_message",
			sourceRoot: source.root,
			sourcePath: path,
			documentEntityId: structure.documentEntityId,
			participants,
		});
		if (result.typeConflicts.length > 0) {
			// Existing rows keep their type; P4's proposal loop owns the retype so
			// it stays auditable rather than a silent connector mutation.
			logger.info("email-source", "Participants already present under a non-person entity type", {
				sourcePath: path,
				identifiers: result.typeConflicts,
			});
		}
	}

	seenPaths.add(path);
	return 1;
}

/**
 * Turn a message into people edges.
 *
 * Only `direct` correspondence produces participants. This is the single most
 * consequential rule in the connector: 61% of the messages in a real synced
 * inbox come from one notification address, and promoting those senders would
 * bury the ~8 humans in the same mailbox under robots.
 */
function buildParticipants(record: MessageRecord, settings: EmailSourceSettings): readonly SourceParticipant[] {
	if (record.correspondence !== "direct") return [];
	const { envelope, parsed } = record;
	const out: SourceParticipant[] = [];
	const messageRef = envelope.messageId || `uid ${envelope.uid}`;

	for (const address of envelope.from) {
		out.push({
			identifier: address.address,
			...(address.name ? { displayName: address.name } : {}),
			edgeType: "authored_by",
			strength: 1,
			reason: `user-asserted: From header of ${messageRef}`,
		});
	}
	for (const address of envelope.to) {
		out.push({
			identifier: address.address,
			...(address.name ? { displayName: address.name } : {}),
			edgeType: "addressed_to",
			strength: 1,
			reason: `user-asserted: To header of ${messageRef}`,
		});
	}
	for (const address of envelope.cc) {
		out.push({
			identifier: address.address,
			...(address.name ? { displayName: address.name } : {}),
			edgeType: "copied_on",
			strength: 1,
			reason: `user-asserted: Cc header of ${messageRef}`,
		});
	}

	if (settings.includeQuotedParticipants && parsed) {
		const envelopeAddresses = new Set(
			[...envelope.from, ...envelope.to, ...envelope.cc].map((address) => address.address),
		);
		for (const quoted of extractQuotedParticipants(parsed.textBody)) {
			if (envelopeAddresses.has(quoted.address)) continue;
			out.push({
				identifier: quoted.address,
				...(quoted.name ? { displayName: quoted.name } : {}),
				edgeType: quoted.role === "from" || quoted.role === "inline" ? "authored_by" : "addressed_to",
				strength: QUOTED_PARTICIPANT_STRENGTH,
				reason: `user-asserted: quoted ${quoted.role} block inside ${messageRef}`,
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Paths and helpers
// ---------------------------------------------------------------------------

function accountArtifactPath(account: string): string {
	return `email://${account}`;
}

function mailboxPath(target: MailboxTarget): string {
	return `email://${target.account}/${target.mailbox}`;
}

/** Message-ID keyed, never UID keyed: UIDs are reassigned when a mailbox is recreated. */
function threadPath(target: MailboxTarget, rootMessageId: string): string {
	return `${mailboxPath(target)}/threads/${encodeURIComponent(rootMessageId)}`;
}

function messagePath(target: MailboxTarget, envelope: EmailEnvelope): string {
	const key = envelope.messageId || `uid:${envelope.uid}`;
	return `${mailboxPath(target)}/messages/${encodeURIComponent(key)}`;
}

function formatAddress(address: EmailAddress): string {
	return address.name ? `${address.name} <${address.address}>` : address.address;
}

function uniqueAddresses(addresses: readonly EmailAddress[]): readonly EmailAddress[] {
	const seen = new Set<string>();
	const out: EmailAddress[] = [];
	for (const address of addresses) {
		if (address.address.length === 0 || seen.has(address.address)) continue;
		seen.add(address.address);
		out.push(address);
	}
	return out;
}

function failureState(
	source: SignetSourceEntry,
	message: string,
	metadata?: Readonly<Record<string, unknown>>,
): SourceFailureState {
	return {
		sourceId: source.id,
		providerKind: EMAIL_PROVIDER_KIND,
		failedAt: new Date().toISOString(),
		recoverable: true,
		message,
		metadata,
	};
}

function writeFailureArtifact(source: SignetSourceEntry, agentId: string, failure: SourceFailureState): number {
	const fingerprint = createHash("sha256")
		.update(failure.message)
		.update("\0")
		.update(JSON.stringify(failure.metadata ?? {}))
		.digest("hex")
		.slice(0, 16);
	indexExternalMemoryArtifact({
		agentId,
		harness: EMAIL_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `failure:${failure.failedAt}:${failure.message}`,
		sourcePath: `email://source/${source.id}/failures/${encodeURIComponent(failure.failedAt)}-${fingerprint}`,
		sourceKind: "source_email_failure",
		sourceMtimeMs: Date.parse(failure.failedAt) || Date.now(),
		capturedAt: failure.failedAt,
		content: failure.message,
		sourceMeta: failure.metadata,
	});
	return 1;
}

function purgeStaleEmailArtifacts(
	sourceId: string,
	agentId: string,
	syncStartedAt: string,
	seenPaths: ReadonlySet<string>,
	target: MailboxTarget,
): void {
	const prefix = `${mailboxPath(target)}/`;
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT rowid, source_path FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_path >= ?
					   AND source_path < ?
					   AND updated_at < ?
					   AND COALESCE(is_deleted, 0) = 0`,
				)
				.all(agentId, sourceId, prefix, `${prefix}￿`, syncStartedAt) as Array<{
				rowid: number;
				source_path: string;
			}>,
	);
	for (const row of rows) {
		if (seenPaths.has(row.source_path)) continue;
		purgeSourceArtifactStructure({ agentId, sourceId, sourcePath: row.source_path });
	}
	getDbAccessor().withWriteTx((db) => {
		for (const row of rows) {
			if (seenPaths.has(row.source_path)) continue;
			countChanges(
				db
					.prepare("UPDATE memory_artifacts SET is_deleted = 1, updated_at = ? WHERE rowid = ?")
					.run(syncStartedAt, row.rowid),
			);
		}
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
