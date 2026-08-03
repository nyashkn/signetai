import { describe, expect, test } from "bun:test";
import { deepLinkForArtifact, parseSourceMeta } from "./source-deep-link";

describe("deepLinkForArtifact", () => {
	test("obsidian absolute path uses the path= form, no vault name needed", () => {
		const link = deepLinkForArtifact({
			sourceKind: "source_obsidian_markdown",
			sourcePath: "/Users/x/vault/research/Causality Book.md",
			meta: { provider: "obsidian", displayName: "Obsidian Vault" },
		});
		expect(link).toBe("obsidian://open?path=%2FUsers%2Fx%2Fvault%2Fresearch%2FCausality%20Book.md");
	});

	test("obsidian relative path yields nothing rather than a broken link", () => {
		expect(
			deepLinkForArtifact({ sourceKind: "source_obsidian_markdown", sourcePath: "research/note.md" }),
		).toBeUndefined();
	});

	test("provider-supplied url wins over any reconstruction", () => {
		expect(
			deepLinkForArtifact({
				sourceKind: "source_github_issue",
				sourcePath: "github://acme/repo/issues/12",
				meta: { url: "https://github.com/acme/repo/issues/12", provider: "github" },
			}),
		).toBe("https://github.com/acme/repo/issues/12");
	});

	test("non-http url in meta is ignored", () => {
		expect(
			deepLinkForArtifact({
				sourceKind: "source_github_issue",
				sourcePath: "github://acme/repo/issues/12",
				meta: { url: "javascript:alert(1)" },
			}),
		).toBeUndefined();
	});

	test("discord message path maps to the web client", () => {
		expect(
			deepLinkForArtifact({
				sourceKind: "source_discord_message",
				sourcePath: "discord://guild/111/channel/222/messages/333",
			}),
		).toBe("https://discord.com/channels/111/222/333");
	});

	test("discord channel path maps without a message id", () => {
		expect(
			deepLinkForArtifact({
				sourceKind: "source_discord_channel",
				sourcePath: "discord://guild/111/channel/222",
			}),
		).toBe("https://discord.com/channels/111/222");
	});

	test("email rebuilds an RFC 2392 message: link from the stored Message-ID", () => {
		expect(
			deepLinkForArtifact({
				sourceKind: "source_email_message",
				sourcePath: "email://pivotplanit/Inbox/messages/%3Cabc%40mail.gmail.com%3E",
				meta: { provider: "email", messageId: "<abc@mail.gmail.com>" },
			}),
		).toBe("message://%3cabc%40mail.gmail.com%3e");
	});

	test("an email artifact with no Message-ID yields nothing rather than a dead link", () => {
		expect(
			deepLinkForArtifact({
				sourceKind: "source_email_thread",
				sourcePath: "email://pivotplanit/Inbox/threads/x",
				meta: { provider: "email" },
			}),
		).toBeUndefined();
	});

	test("unknown kinds and empty paths are undefined, never a guess", () => {
		expect(deepLinkForArtifact({ sourceKind: "transcript", sourcePath: "/tmp/a.jsonl" })).toBeUndefined();
		expect(deepLinkForArtifact({ sourceKind: "source_obsidian_markdown", sourcePath: "" })).toBeUndefined();
	});
});

describe("parseSourceMeta", () => {
	test("parses an object, rejects everything else", () => {
		expect(parseSourceMeta('{"provider":"obsidian"}')).toEqual({ provider: "obsidian" });
		expect(parseSourceMeta("[1,2]")).toBeNull();
		expect(parseSourceMeta("not json")).toBeNull();
		expect(parseSourceMeta("null")).toBeNull();
		expect(parseSourceMeta(null)).toBeNull();
		expect(parseSourceMeta("")).toBeNull();
	});
});
