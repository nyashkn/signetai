import { describe, expect, test } from "bun:test";
import {
	classifyCorrespondence,
	decodeMimeWords,
	extractQuotedParticipants,
	extractTextBody,
	isRobotAddress,
	parseAddressList,
	parseEmailMessage,
	parseHeaders,
	parseMessageIdList,
} from "./email-message-parse";

const OWN = new Set(["njui@pivotplanit.com"]);

function crlf(value: string): string {
	return value.replace(/\n/g, "\r\n");
}

describe("parseHeaders", () => {
	test("unfolds continuation lines and keeps repeated headers", () => {
		const headers = parseHeaders(
			crlf(["Subject: Sales Cycle", "Received: from a", "\tby b", "Received: from c", "", "body"].join("\n")),
		);
		expect(headers.get("subject")).toEqual(["Sales Cycle"]);
		expect(headers.get("received")).toEqual(["from a by b", "from c"]);
	});

	test("stops at the header/body separator", () => {
		const headers = parseHeaders(crlf("From: a@b\n\nTo: not-a-header@c\n"));
		expect(headers.has("to")).toBe(false);
	});
});

describe("decodeMimeWords", () => {
	test("decodes Q and B encoded words, leaves plain text alone", () => {
		expect(decodeMimeWords("=?UTF-8?Q?PivotPlanIt?=")).toBe("PivotPlanIt");
		expect(decodeMimeWords("=?UTF-8?B?SGVsbG8=?=")).toBe("Hello");
		expect(decodeMimeWords("=?UTF-8?Q?caf=C3=A9?=")).toBe("café");
		expect(decodeMimeWords("Matt West")).toBe("Matt West");
	});

	test("underscore is a space in Q encoding", () => {
		expect(decodeMimeWords("=?UTF-8?Q?Matt_West?=")).toBe("Matt West");
	});
});

describe("parseAddressList", () => {
	test("splits on commas outside quotes and angle brackets", () => {
		expect(parseAddressList('Njui <njui@pivotplanit.com>, "Alecia, R" <alecia.robi@gmail.com>')).toEqual([
			{ name: "Njui", address: "njui@pivotplanit.com" },
			{ name: "Alecia, R", address: "alecia.robi@gmail.com" },
		]);
	});

	test("handles a display name that looks like a domain", () => {
		expect(parseAddressList('"matt dock-blocks.com" <matt@dock-blocks.com>')).toEqual([
			{ name: "matt dock-blocks.com", address: "matt@dock-blocks.com" },
		]);
	});

	test("drops the href smuggled in by plain-text renderings of HTML mail", () => {
		// Real shape seen in the wild: the anchor target is appended inside the
		// angle brackets. Taking it whole minted a junk person entity whose
		// canonical name was 90 characters of URL.
		expect(
			parseAddressList('"Apollo Partners" <partners@apollo.io mailto:partners@apollo.io?to=%22apollo%22>'),
		).toEqual([{ name: "Apollo Partners", address: "partners@apollo.io" }]);
	});

	test("rejects fragments that are not addresses instead of minting them", () => {
		expect(parseAddressList('is"<')).toEqual([]);
		expect(parseAddressList("<not-an-address>")).toEqual([]);
		expect(parseAddressList("Matt West")).toEqual([]);
		expect(parseAddressList("<user@localdomain>")).toEqual([]);
	});

	test("bare addresses and empty headers", () => {
		expect(parseAddressList("njui@pivotplanit.com")).toEqual([{ name: "", address: "njui@pivotplanit.com" }]);
		expect(parseAddressList("   ")).toEqual([]);
	});
});

describe("parseMessageIdList", () => {
	test("keeps angle brackets and order", () => {
		expect(parseMessageIdList("<a@x> <b@y>")).toEqual(["<a@x>", "<b@y>"]);
		expect(parseMessageIdList("")).toEqual([]);
	});
});

describe("extractTextBody", () => {
	test("prefers text/plain inside multipart/alternative and decodes quoted-printable", () => {
		const raw = crlf(
			[
				'Content-Type: multipart/alternative; boundary="000000000000bb06d406581b8a8e"',
				"",
				"--000000000000bb06d406581b8a8e",
				'Content-Type: text/plain; charset="UTF-8"',
				"Content-Transfer-Encoding: quoted-printable",
				"",
				"On Sun, Aug 2, 2026 at 10:03=E2=80=AFPM Mike Eastman <mike@dock-blocks.com>=",
				" wrote:",
				"",
				"--000000000000bb06d406581b8a8e",
				'Content-Type: text/html; charset="UTF-8"',
				"",
				"<p>ignore me</p>",
				"--000000000000bb06d406581b8a8e--",
				"",
			].join("\n"),
		);
		const body = extractTextBody(raw);
		// The soft break rejoins the wrapped address and =E2=80=AF is a narrow nbsp.
		expect(body).toContain("Mike Eastman <mike@dock-blocks.com> wrote:");
		expect(body).toContain("10:03 PM");
		expect(body).not.toContain("ignore me");
	});

	test("falls back to stripped html when there is no plain part", () => {
		const raw = crlf(
			[
				'Content-Type: multipart/alternative; boundary="b1"',
				"",
				"--b1",
				'Content-Type: text/html; charset="UTF-8"',
				"",
				"<p>Hello <b>Matt</b></p><p>Bye</p>",
				"--b1--",
				"",
			].join("\n"),
		);
		expect(extractTextBody(raw)).toBe("Hello Matt\nBye");
	});

	test("non-MIME message returns its body verbatim", () => {
		expect(extractTextBody(crlf("From: a@b\n\nplain text\n"))).toBe("plain text\r\n");
	});

	test("base64 part decodes as UTF-8", () => {
		const raw = crlf(
			['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", "Y2Fmw6k=", ""].join("\n"),
		);
		expect(extractTextBody(raw).trim()).toBe("café");
	});
});

describe("classifyCorrespondence", () => {
	test("List-Unsubscribe is decisive even when addressed to us", () => {
		const headers = parseHeaders(
			crlf(
				[
					"From: Katie Shore <katie@mail.clickup.com>",
					"To: njui@pivotplanit.com",
					"Reply-To: help@clickup.com",
					"List-Unsubscribe: <https://links.iterable.com/s/uh/xyz>",
					"",
					"",
				].join("\n"),
			),
		);
		const verdict = classifyCorrespondence({ headers, ownAddresses: OWN });
		expect(verdict.class).toBe("bulk");
		expect(verdict.signals).toContain("list-unsubscribe");
	});

	test("transactional notification without List-Unsubscribe is still not direct", () => {
		// Real shape of a ClickUp task notification: no list headers, an ESP
		// delivery marker, a robot local part, and a blank Reply-To.
		const headers = parseHeaders(
			crlf(
				[
					"From: PivotPlanIt <notifications@tasks.clickup.com>",
					"To: njui@pivotplanit.com",
					"Reply-To: ",
					"Feedback-ID: ::1.us-east-1.abc=:AmazonSES",
					"",
					"",
				].join("\n"),
			),
		);
		const verdict = classifyCorrespondence({ headers, ownAddresses: OWN });
		expect(verdict.class).toBe("notification");
		expect(verdict.signals).toContain("feedback-id");
		expect(verdict.signals).toContain("reply-to:empty");
		expect(verdict.signals).toContain("explicitly-addressed");
	});

	test("ordinary human mail is direct", () => {
		const headers = parseHeaders(
			crlf(
				[
					"From: Matt West <westmatt81@gmail.com>",
					"To: Njui <njui@pivotplanit.com>, Alecia <alecia.robi@gmail.com>",
					"Subject: Sales Cycle Time",
					"",
					"",
				].join("\n"),
			),
		);
		expect(classifyCorrespondence({ headers, ownAddresses: OWN }).class).toBe("direct");
	});

	test("reciprocity rescues a robot-shaped address we have written to", () => {
		const headers = parseHeaders(crlf("From: Support <support@vendor.com>\nTo: njui@pivotplanit.com\n\n"));
		expect(classifyCorrespondence({ headers, ownAddresses: OWN }).class).toBe("notification");
		expect(classifyCorrespondence({ headers, ownAddresses: OWN, reciprocated: true }).class).toBe("direct");
	});

	test("a live reply chain rescues a robot-shaped address, but a bulk list never is", () => {
		const robot = parseHeaders(crlf("From: alerts@vendor.com\nTo: njui@pivotplanit.com\n\n"));
		expect(classifyCorrespondence({ headers: robot, ownAddresses: OWN, repliesToKnownMessage: true }).class).toBe(
			"direct",
		);
		const list = parseHeaders(crlf("From: alerts@vendor.com\nList-Id: <x.vendor.com>\n\n"));
		expect(classifyCorrespondence({ headers: list, ownAddresses: OWN, repliesToKnownMessage: true }).class).toBe(
			"bulk",
		);
	});
});

describe("isRobotAddress", () => {
	test("separates unattended mailboxes from people using only the address", () => {
		// This is the sole bulk signal available from an IMAP ENVELOPE, so a
		// message whose body was never downloaded still classifies correctly.
		expect(isRobotAddress("notifications@tasks.clickup.com")).toBe(true);
		expect(isRobotAddress("noreply@clickup.com")).toBe(true);
		expect(isRobotAddress("no-reply@x.com")).toBe(true);
		expect(isRobotAddress("bounce+123@x.com")).toBe(true);
		expect(isRobotAddress("alecia.robi@gmail.com")).toBe(false);
		expect(isRobotAddress("westmatt81@gmail.com")).toBe(false);
		expect(isRobotAddress("matt@dock-blocks.com")).toBe(false);
		// Prefix-only matches must not fire: a person is not a robot.
		expect(isRobotAddress("noreplacement@x.com")).toBe(false);
		expect(isRobotAddress("alerta@x.com")).toBe(false);
	});
});

describe("extractQuotedParticipants", () => {
	// Verbatim from a real forwarded Outlook chain in the pivotplanit inbox.
	const FORWARD_BODY = [
		"You will receive replies directly to your inbox for anything we send out",
		"",
		"On Sun, Aug 2, 2026 at 10:03 PM Mike Eastman <mike@dock-blocks.com>",
		" wrote:",
		"",
		"> I did not get this or any of these unless you forward them to me",
		"> ------------------------------",
		"> *From:* matt dock-blocks.com <matt@dock-blocks.com>",
		"> *Sent:* Sunday, August 2, 2026 12:00 PM",
		"> *To:* Mike Eastman <mike@dock-blocks.com>; Alecia <alecia.robi@gmail.com>",
		"> *Subject:* Fw: Still thinking about your Dock Blocks project?",
		">",
		"> ------------------------------",
		"> *From:* Ken Parks <kp8713@gmail.com>",
		"> *Sent:* Sunday, August 2, 2026 7:56 AM",
		"> *To:* matt dock-blocks.com <matt@dock-blocks.com>",
		">",
		"> ------------------------------",
		"> *From:* Dock Blocks <matt@dock-blocks.com>",
		"> *To:* kp8713@gmail.com <kp8713@gmail.com>",
	].join("\n");

	test("pulls every name/address pair out of a nested Outlook forward", () => {
		const participants = extractQuotedParticipants(FORWARD_BODY);
		const froms = participants.filter((entry) => entry.role === "from");
		expect(froms).toEqual([
			{ name: "matt dock-blocks.com", address: "matt@dock-blocks.com", role: "from" },
			{ name: "Ken Parks", address: "kp8713@gmail.com", role: "from" },
			{ name: "Dock Blocks", address: "matt@dock-blocks.com", role: "from" },
		]);
	});

	test("catches the Gmail inline attribution form", () => {
		const inline = extractQuotedParticipants(FORWARD_BODY).filter((entry) => entry.role === "inline");
		expect(inline).toEqual([{ name: "Mike Eastman", address: "mike@dock-blocks.com", role: "inline" }]);
	});

	test("splits Outlook semicolon recipient lists", () => {
		const to = extractQuotedParticipants(FORWARD_BODY).filter((entry) => entry.role === "to");
		expect(to).toContainEqual({ name: "Mike Eastman", address: "mike@dock-blocks.com", role: "to" });
		expect(to).toContainEqual({ name: "Alecia", address: "alecia.robi@gmail.com", role: "to" });
	});

	test("a body with no quoted blocks yields nothing", () => {
		expect(extractQuotedParticipants("Hi, see attached.\n\nThanks")).toEqual([]);
	});
});

describe("parseEmailMessage", () => {
	test("assembles threading headers and body in one pass", () => {
		const raw = crlf(
			[
				"References: <a@x> <b@y>",
				"In-Reply-To: <b@y>",
				"Message-ID: <c@z>",
				"From: =?UTF-8?Q?Alecia?= <alecia.robi@gmail.com>",
				"To: Mike Eastman <mike@dock-blocks.com>",
				'Cc: "matt dock-blocks.com" <matt@dock-blocks.com>',
				"Subject: Re: Still thinking about your Dock Blocks project?",
				"Date: Sun, 02 Aug 2026 16:43:30 +0000",
				'Content-Type: text/plain; charset="UTF-8"',
				"",
				"body text",
				"",
			].join("\n"),
		);
		const parsed = parseEmailMessage(raw);
		expect(parsed.messageId).toBe("<c@z>");
		expect(parsed.inReplyTo).toBe("<b@y>");
		expect(parsed.references).toEqual(["<a@x>", "<b@y>"]);
		expect(parsed.from).toEqual([{ name: "Alecia", address: "alecia.robi@gmail.com" }]);
		expect(parsed.cc).toEqual([{ name: "matt dock-blocks.com", address: "matt@dock-blocks.com" }]);
		expect(parsed.textBody.trim()).toBe("body text");
	});

	test("missing threading headers are empty, never undefined", () => {
		const parsed = parseEmailMessage(crlf("From: a@b\n\nhi\n"));
		expect(parsed.messageId).toBe("");
		expect(parsed.inReplyTo).toBe("");
		expect(parsed.references).toEqual([]);
		expect(parsed.cc).toEqual([]);
	});
});

describe("smuggled href with no separator", () => {
	test("an inline attribution keeps the address and drops the appended mailto href", () => {
		// Real shape from the pivotplanit Inbox, found only by a live ingest: the
		// href abuts the address with no space, so the first-token rule alone let
		// `matt@dock-blocks.com<mailto:matt@dock-blocks.com` through as one
		// identifier and minted an entity named after it.
		const body = [
			"Numbers below.",
			"",
			"On Sun, Aug 2, 2026 at 10:03 PM Matt West <matt@dock-blocks.com<mailto:matt@dock-blocks.com> wrote:",
			"",
			"> Forwarded for visibility",
		].join("\r\n");

		const participants = extractQuotedParticipants(body);
		expect(participants.map((p) => p.address)).toEqual(["matt@dock-blocks.com"]);
	});

	test("a quoted header line with the same shape is cleaned too", () => {
		const body = "*From:* Matt West <matt@dock-blocks.com<mailto:matt@dock-blocks.com>";
		expect(extractQuotedParticipants(body).map((p) => p.address)).toEqual(["matt@dock-blocks.com"]);
	});
});
