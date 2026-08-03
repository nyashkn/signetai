/**
 * RFC 5322 / MIME parsing for the email source connector.
 *
 * Pure functions only — no IMAP, no subprocess, no database. The connector
 * hands raw message bytes in and gets headers, a text body, participants and a
 * correspondence class out, which keeps the interesting logic testable without
 * a mailbox.
 *
 * Deliberately not a general MIME library: we need the first `text/plain` part
 * and the threading headers, nothing else. A dependency for that would be a
 * bigger surface than the ~200 lines below.
 */

export interface EmailAddress {
	/** Display name as written by the sender, RFC 2047 decoded. Empty when the header carried a bare address. */
	readonly name: string;
	/** Lowercased addr-spec. Empty when the header was unparseable. */
	readonly address: string;
}

/** Lowercased header name to the values seen, in order. Repeated headers keep every occurrence. */
export type EmailHeaders = ReadonlyMap<string, readonly string[]>;

/**
 * How the message reached the mailbox. Governs whether the sender is promoted
 * into the identity graph — never whether the message is stored.
 */
export type CorrespondenceClass = "direct" | "notification" | "bulk";

export interface CorrespondenceVerdict {
	readonly class: CorrespondenceClass;
	/** Header names / rules that produced the verdict, for the artifact's audit trail. */
	readonly signals: readonly string[];
}

export interface QuotedParticipant {
	readonly name: string;
	readonly address: string;
	/** Which quoted-header field the pair came from — `from`, `to`, `cc`, or `inline` for the "X wrote:" form. */
	readonly role: "from" | "to" | "cc" | "inline";
}

export interface ParsedEmailMessage {
	readonly headers: EmailHeaders;
	readonly messageId: string;
	readonly inReplyTo: string;
	/** Parsed `References`, oldest first. Empty when absent. */
	readonly references: readonly string[];
	readonly subject: string;
	readonly date: string;
	readonly from: readonly EmailAddress[];
	readonly to: readonly EmailAddress[];
	readonly cc: readonly EmailAddress[];
	readonly replyTo: readonly EmailAddress[];
	readonly textBody: string;
}

const BULK_LIST_HEADERS = ["list-unsubscribe", "list-id", "list-post", "list-help"] as const;
const ESP_DELIVERY_HEADERS = ["feedback-id", "x-ses-outgoing", "x-sg-eid", "x-mailgun-sid", "x-campaignid"] as const;
const ROBOT_LOCAL_PARTS =
	/^(no-?reply|notifications?|donotreply|do-not-reply|mailer-daemon|bounce[s+-]?|postmaster|automated|alerts?|support|updates?)([+.-]|$)/i;

/**
 * Does this address belong to a mailbox nobody reads?
 *
 * Exported because it is the one bulk signal derivable from an IMAP ENVELOPE
 * alone — the connector can classify a message whose body it has not paid to
 * download, which matters when a mailbox is larger than the per-sync body
 * budget.
 */
export function isRobotAddress(address: string): boolean {
	const localPart = address.split("@")[0] ?? "";
	return ROBOT_LOCAL_PARTS.test(localPart);
}

/** Header field name to value, tolerating folded continuation lines and both CRLF and LF. */
export function parseHeaders(rawMessage: string): EmailHeaders {
	const headerBlock = splitMessage(rawMessage).head;
	const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
	const headers = new Map<string, string[]>();
	for (const line of unfolded.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const name = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		const existing = headers.get(name);
		if (existing) existing.push(value);
		else headers.set(name, [value]);
	}
	return headers;
}

export function headerValue(headers: EmailHeaders, name: string): string {
	return headers.get(name.toLowerCase())?.[0] ?? "";
}

/**
 * RFC 2047 encoded-word decoding (`=?UTF-8?Q?PivotPlanIt?=`). Unknown charsets
 * are decoded as UTF-8, which is right often enough and never throws.
 */
export function decodeMimeWords(value: string): string {
	return value.replace(
		/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
		(whole, charset: string, encoding: string, text: string) => {
			try {
				const bytes =
					encoding.toLowerCase() === "b" ? base64ToBytes(text) : quotedPrintableToBytes(text.replace(/_/g, " "));
				return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(bytes);
			} catch {
				return whole;
			}
		},
	);
}

/**
 * Split an address-list header into name/address pairs. Handles quoted display
 * names and comma-in-quotes, which real senders produce constantly
 * (`"matt dock-blocks.com" <matt@dock-blocks.com>`).
 */
export function parseAddressList(value: string): readonly EmailAddress[] {
	if (!value.trim()) return [];
	const out: EmailAddress[] = [];
	let current = "";
	let inQuotes = false;
	let inAngle = false;
	for (const char of value) {
		if (char === '"') inQuotes = !inQuotes;
		else if (char === "<" && !inQuotes) inAngle = true;
		else if (char === ">" && !inQuotes) inAngle = false;
		if (char === "," && !inQuotes && !inAngle) {
			out.push(parseSingleAddress(current));
			current = "";
			continue;
		}
		current += char;
	}
	out.push(parseSingleAddress(current));
	return out.filter((entry) => entry.address.length > 0);
}

/**
 * Conservative addr-spec check. Anything that fails becomes an empty address
 * and is dropped by `parseAddressList`, because a malformed identifier would
 * otherwise mint a junk `person` entity that is expensive to remove later.
 */
const ADDR_SPEC = /^[^\s@<>",;:\\()[\]]+@[^\s@<>",;:\\()[\]]+\.[^\s@<>",;:\\()[\]]+$/;

function normalizeAddress(raw: string): string {
	// Plain-text renderings of HTML mail smuggle the anchor href in beside the
	// address, in two shapes seen on real mail:
	//   `partners@apollo.io mailto:partners@apollo.io?to=...`   (space separated)
	//   `matt@dock-blocks.com<mailto:matt@dock-blocks.com`      (no separator)
	// Keep the first whitespace token, then cut at any interior `<`. A `<` cannot
	// appear inside an addr-spec, so everything from it on is the smuggled half.
	const first = raw.trim().split(/\s+/)[0] ?? "";
	const withoutBrackets = first.replace(/^[<"']+/, "");
	const cleaned = withoutBrackets
		.split("<")[0]
		?.replace(/[>"',;.]+$/, "")
		.toLowerCase();
	return cleaned !== undefined && ADDR_SPEC.test(cleaned) ? cleaned : "";
}

function parseSingleAddress(raw: string): EmailAddress {
	const trimmed = decodeMimeWords(raw.trim());
	const angled = /^(.*?)<([^>]*)>\s*$/.exec(trimmed);
	if (angled) {
		return { name: stripQuotes(angled[1] ?? "").trim(), address: normalizeAddress(angled[2] ?? "") };
	}
	return { name: "", address: normalizeAddress(trimmed) };
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

/** `<a@b> <c@d>` style header (References, In-Reply-To) to bare ids, angle brackets kept. */
export function parseMessageIdList(value: string): readonly string[] {
	return [...value.matchAll(/<[^>\s]+>/g)].map((match) => match[0]);
}

/**
 * First `text/plain` part, transfer-decoded. Falls back to the whole body for
 * non-MIME mail, and to a tag-stripped `text/html` part when a sender ships
 * HTML only.
 */
export function extractTextBody(rawMessage: string): string {
	const { head, body } = splitMessage(rawMessage);
	const headers = parseHeaders(`${head}\r\n\r\n`);
	return extractTextFromPart(headers, body);
}

function extractTextFromPart(headers: EmailHeaders, body: string): string {
	const contentType = headerValue(headers, "content-type").toLowerCase();
	if (contentType.startsWith("multipart/")) {
		const boundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(headerValue(headers, "content-type"))?.[1];
		if (!boundary) return "";
		const parts = splitMultipart(body, boundary.trim());
		const decoded = parts.map((part) => {
			const split = splitMessage(part);
			return { headers: parseHeaders(`${split.head}\r\n\r\n`), body: split.body };
		});
		// ponytail: prefer text/plain anywhere in the tree, then HTML, rather than
		// modelling alternative-vs-mixed. `multipart/alternative` puts plain first
		// and `multipart/mixed` nests it, and both fall out of a depth-first scan.
		for (const part of decoded) {
			const found = extractTextFromPart(part.headers, part.body);
			if (found.trim().length > 0 && !isHtmlPart(part.headers)) return found;
		}
		for (const part of decoded) {
			const found = extractTextFromPart(part.headers, part.body);
			if (found.trim().length > 0) return found;
		}
		return "";
	}
	const decoded = decodeTransferEncoding(body, headerValue(headers, "content-transfer-encoding"), contentType);
	return isHtmlPart(headers) ? stripHtml(decoded) : decoded;
}

function isHtmlPart(headers: EmailHeaders): boolean {
	return headerValue(headers, "content-type").toLowerCase().startsWith("text/html");
}

function splitMultipart(body: string, boundary: string): readonly string[] {
	const delimiter = `--${boundary}`;
	return body
		.split(new RegExp(`(?:^|\\r?\\n)${escapeRegExp(delimiter)}(?:--)?[ \\t]*(?:\\r?\\n|$)`))
		.slice(1, -1)
		.filter((part) => part.trim().length > 0);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeTransferEncoding(body: string, encoding: string, contentType: string): string {
	const charset = normalizeCharset(/charset\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1] ?? "utf-8");
	const normalized = encoding.trim().toLowerCase();
	const decoder = new TextDecoder(charset, { fatal: false });
	if (normalized === "base64") return decoder.decode(base64ToBytes(body));
	if (normalized === "quoted-printable") return decoder.decode(quotedPrintableToBytes(body));
	return body;
}

function normalizeCharset(charset: string): string {
	const cleaned = charset
		.trim()
		.toLowerCase()
		.replace(/^["']|["']$/g, "");
	// TextDecoder rejects a handful of labels real mail still uses.
	if (cleaned === "" || cleaned === "us-ascii" || cleaned === "ascii" || cleaned === "unknown-8bit") return "utf-8";
	return cleaned;
}

function quotedPrintableToBytes(value: string): Uint8Array {
	// Soft line breaks first, so `=E2=80\r\n=AF` reassembles into one code point.
	const joined = value.replace(/=\r?\n/g, "");
	const bytes: number[] = [];
	for (let index = 0; index < joined.length; index++) {
		const char = joined[index] ?? "";
		if (char === "=" && index + 2 < joined.length) {
			const hex = joined.slice(index + 1, index + 3);
			if (/^[0-9a-fA-F]{2}$/.test(hex)) {
				bytes.push(Number.parseInt(hex, 16));
				index += 2;
				continue;
			}
		}
		for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
	}
	return Uint8Array.from(bytes);
}

function base64ToBytes(value: string): Uint8Array {
	const cleaned = value.replace(/[^A-Za-z0-9+/=]/g, "");
	if (cleaned.length === 0) return new Uint8Array(0);
	const binary = atob(cleaned);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function stripHtml(value: string): string {
	return value
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function splitMessage(rawMessage: string): { readonly head: string; readonly body: string } {
	const match = /\r?\n\r?\n/.exec(rawMessage);
	if (!match) return { head: rawMessage, body: "" };
	return {
		head: rawMessage.slice(0, match.index),
		body: rawMessage.slice(match.index + match[0].length),
	};
}

export function parseEmailMessage(rawMessage: string): ParsedEmailMessage {
	const headers = parseHeaders(rawMessage);
	return {
		headers,
		messageId: parseMessageIdList(headerValue(headers, "message-id"))[0] ?? "",
		inReplyTo: parseMessageIdList(headerValue(headers, "in-reply-to"))[0] ?? "",
		references: parseMessageIdList(headerValue(headers, "references")),
		subject: decodeMimeWords(headerValue(headers, "subject")),
		date: headerValue(headers, "date"),
		from: parseAddressList(headerValue(headers, "from")),
		to: parseAddressList(headerValue(headers, "to")),
		cc: parseAddressList(headerValue(headers, "cc")),
		replyTo: parseAddressList(headerValue(headers, "reply-to")),
		textBody: extractTextBody(rawMessage),
	};
}

export interface ClassifyCorrespondenceInput {
	readonly headers: EmailHeaders;
	/** Addresses owned by the account being synced, lowercased. */
	readonly ownAddresses: ReadonlySet<string>;
	/** True when `In-Reply-To` names a message this sync already holds. */
	readonly repliesToKnownMessage?: boolean;
	/** True when the account has previously sent mail to the `From` address. */
	readonly reciprocated?: boolean;
}

/**
 * Decide whether a message is human correspondence.
 *
 * Bulk-list markers are decisive — a message carrying `List-Unsubscribe` is
 * not personal mail no matter who else is on it. Everything below that is
 * evidence rather than proof, so a direct address or a live reply chain can
 * outvote the weaker robot heuristics. Reciprocity is treated as strongest
 * because "I have written to this address" is an assertion, not an inference.
 */
export function classifyCorrespondence(input: ClassifyCorrespondenceInput): CorrespondenceVerdict {
	const { headers, ownAddresses } = input;
	const signals: string[] = [];

	for (const header of BULK_LIST_HEADERS) {
		if (headers.has(header)) signals.push(header);
	}
	const precedence = headerValue(headers, "precedence").toLowerCase();
	if (precedence === "bulk" || precedence === "list" || precedence === "junk") signals.push(`precedence:${precedence}`);
	if (signals.length > 0) return { class: "bulk", signals };

	const robotSignals: string[] = [];
	const autoSubmitted = headerValue(headers, "auto-submitted").toLowerCase();
	if (autoSubmitted && autoSubmitted !== "no") robotSignals.push(`auto-submitted:${autoSubmitted}`);
	for (const header of ESP_DELIVERY_HEADERS) {
		if (headers.has(header)) robotSignals.push(header);
	}
	const from = parseAddressList(headerValue(headers, "from"));
	const replyTo = parseAddressList(headerValue(headers, "reply-to"));
	for (const address of [...from, ...replyTo]) {
		if (isRobotAddress(address.address)) robotSignals.push(`robot-local-part:${address.address}`);
	}
	// A `Reply-To:` header that is present but blank is a deliberate "do not
	// answer this" — ClickUp's task notifications are the local example.
	if (headers.has("reply-to") && headerValue(headers, "reply-to").trim() === "") robotSignals.push("reply-to:empty");

	if (robotSignals.length === 0) return { class: "direct", signals: ["no-bulk-markers"] };

	if (input.reciprocated === true) return { class: "direct", signals: [...robotSignals, "reciprocated"] };
	if (input.repliesToKnownMessage === true) return { class: "direct", signals: [...robotSignals, "reply-chain"] };

	const recipients = [...parseAddressList(headerValue(headers, "to")), ...parseAddressList(headerValue(headers, "cc"))];
	if (recipients.some((address) => ownAddresses.has(address.address))) {
		// Addressed to us by name but robot-shaped: a transactional notification,
		// not a broadcast. Still not a person we should mint an entity for.
		return { class: "notification", signals: [...robotSignals, "explicitly-addressed"] };
	}
	return { class: "notification", signals: robotSignals };
}

const QUOTED_HEADER_LINE = /^\s*(?:>\s*)*\*?(From|To|Cc|Sent|Subject)\*?\s*:\s*\*?\s*(.*?)\s*\*?$/i;
// Spans lines on purpose: Gmail wraps its attribution mid-sentence, so the
// `wrote:` regularly lands on the line after the address.
const INLINE_ATTRIBUTION = /On[\s\S]{4,120}?\s([^<>\n]{1,60}?)\s*<([^>@\s]+@[^>\s]+)>[\s>]*wrote:/gi;

/**
 * Name↔address pairs asserted inside quoted forward and reply blocks.
 *
 * These are the cheapest identity evidence available: the quoting client wrote
 * both halves of the pair itself, so a hit is an assertion at confidence 1.0
 * rather than a guess. One forwarded Outlook chain resolves several people who
 * never appear in an envelope header.
 */
/**
 * `On <date> at <time> <Name> <addr> wrote:` — every client localizes the date
 * part differently, so drop everything through the last timestamp, year or
 * comma rather than trying to parse dates in N locales.
 */
function cleanAttributionName(raw: string): string {
	const cleaned = raw.replace(/^[\s\S]*(?:\d{1,2}:\d{2}(?:[\s ]*[AP]\.?M\.?)?|\b\d{4}\b|,)[\s ]*/i, "").trim();
	return cleaned.length > 0 ? cleaned : raw.trim();
}

export function extractQuotedParticipants(textBody: string): readonly QuotedParticipant[] {
	const seen = new Set<string>();
	const out: QuotedParticipant[] = [];
	const push = (participant: QuotedParticipant): void => {
		if (participant.address.length === 0) return;
		const key = `${participant.role}:${participant.address}:${participant.name.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(participant);
	};

	for (const inline of textBody.matchAll(INLINE_ATTRIBUTION)) {
		// Through `normalizeAddress`, not raw: the capture group tolerates a second
		// `@` and a `<`, so a smuggled `addr<mailto:addr` href reached the graph as
		// one identifier and minted an entity named after it.
		push({
			name: cleanAttributionName(inline[1] ?? ""),
			address: normalizeAddress(inline[2] ?? ""),
			role: "inline",
		});
	}

	for (const line of textBody.split(/\r?\n/)) {
		const quoted = QUOTED_HEADER_LINE.exec(line);
		if (!quoted) continue;
		const field = (quoted[1] ?? "").toLowerCase();
		if (field !== "from" && field !== "to" && field !== "cc") continue;
		// Outlook writes `To:` lists separated by `;` rather than `,`.
		for (const address of parseAddressList((quoted[2] ?? "").replace(/;/g, ","))) {
			push({ name: address.name, address: address.address, role: field });
		}
	}
	return out;
}
