/**
 * Deep links back to the originating application for a source artifact.
 *
 * Recall surfaces the artifact text; this maps it back to the thing a human can
 * open. Connectors already persist everything needed — `source_path` plus the
 * provider payload in `memory_artifacts.source_meta_json` — so this is a pure
 * projection with no extra storage.
 */

export interface SourceDeepLinkInput {
	readonly sourceKind: string;
	readonly sourcePath: string;
	/** Parsed `memory_artifacts.source_meta_json`, when present. */
	readonly meta?: Readonly<Record<string, unknown>> | null;
}

function str(meta: SourceDeepLinkInput["meta"], key: string): string | undefined {
	const value = meta?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `discord://guild/{g}/channel/{c}/messages/{m}` is the internal artifact path
 * written by the Discord provider; the web client uses a different shape.
 */
function discordDeepLink(sourcePath: string): string | undefined {
	const match = /^discord:\/\/guild\/([^/]+)\/channel\/([^/]+)\/messages\/([^/]+)/.exec(sourcePath);
	if (match) return `https://discord.com/channels/${match[1]}/${match[2]}/${match[3]}`;
	const channel = /^discord:\/\/guild\/([^/]+)\/channel\/([^/]+)$/.exec(sourcePath);
	if (channel) return `https://discord.com/channels/${channel[1]}/${channel[2]}`;
	return undefined;
}

/**
 * `message:` is the RFC 2392 scheme that macOS Mail, Thunderbird and most
 * desktop clients register, so the link opens whichever client the user already
 * uses rather than pinning them to one webmail. Reconstructed from the stored
 * `Message-ID` instead of the artifact path because the path is URL-encoded and
 * mailbox-scoped, while the Message-ID is globally unique and permanent.
 */
function emailDeepLink(meta: SourceDeepLinkInput["meta"]): string | undefined {
	const messageId = str(meta, "messageId");
	if (!messageId) return undefined;
	const bare = messageId.replace(/^<|>$/g, "");
	if (bare.length === 0) return undefined;
	return `message://%3c${encodeURIComponent(bare)}%3e`;
}

export function deepLinkForArtifact(input: SourceDeepLinkInput): string | undefined {
	const { sourceKind, sourcePath, meta } = input;
	if (sourcePath.length === 0) return undefined;

	// Providers that carry an authoritative URL win outright — GitHub records the
	// canonical html_url at fetch time, so never reconstruct what was handed to us.
	const explicit = str(meta, "url") ?? str(meta, "html_url");
	if (explicit && /^https?:\/\//.test(explicit)) return explicit;

	if (sourceKind.startsWith("source_discord")) return discordDeepLink(sourcePath);

	if (sourceKind.startsWith("source_email")) return emailDeepLink(meta);

	if (sourceKind.startsWith("source_obsidian") || sourceKind === "source_obsidian_markdown") {
		// ponytail: `path=` takes an absolute path, so no vault-name lookup is
		// needed. `source_root` is NULL on existing rows anyway.
		if (!sourcePath.startsWith("/")) return undefined;
		return `obsidian://open?path=${encodeURIComponent(sourcePath)}`;
	}

	return undefined;
}

/** Tolerant parse for the `source_meta_json` TEXT column. */
export function parseSourceMeta(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
