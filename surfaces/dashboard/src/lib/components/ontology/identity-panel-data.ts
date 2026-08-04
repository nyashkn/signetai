import type { TouchedItemRecord } from "$lib/api";

/**
 * Connector-minted entities are named `<subject> - source:email:<hash>:document:<uri>`
 * — unique by construction, unreadable in a list. The subject is the only part
 * a person recognises, and the uri it drops is already carried by the deep link.
 */
export function touchedTitle(name: string): string {
	const cut = name.indexOf(" - source:");
	const title = cut > 0 ? name.slice(0, cut) : name;
	return title.trim().length > 0 ? title.trim() : name;
}

export interface TouchedGroup {
	readonly sourceKind: string;
	readonly label: string;
	readonly items: readonly TouchedItemRecord[];
}

const SOURCE_LABELS: Record<string, string> = {
	source_email_message: "Email",
	source_email_thread: "Email threads",
	source_github_issue: "GitHub",
	source_discord_message: "Discord",
	source_obsidian_markdown: "Obsidian",
};

/**
 * Grouped by source because the graph holds two populations that have not been
 * joined yet: connector rows carry a `source_kind` and a deep link, extraction
 * rows carry neither. Mixing them in one list reads as an inconsistent trail;
 * separating them makes the split visible for what it is.
 */
export function groupTouchedBySource(items: readonly TouchedItemRecord[]): TouchedGroup[] {
	const groups = new Map<string, TouchedItemRecord[]>();
	for (const item of items) {
		const key = item.sourceKind ?? "";
		const bucket = groups.get(key);
		if (bucket) bucket.push(item);
		else groups.set(key, [item]);
	}
	return (
		[...groups.entries()]
			.map(([sourceKind, grouped]) => ({
				sourceKind,
				label: SOURCE_LABELS[sourceKind] ?? (sourceKind === "" ? "Extracted from memories" : sourceKind),
				items: grouped,
			}))
			// A deep-linked source is the one a reviewer can actually follow, so it
			// leads; the unlinked extraction bucket sinks regardless of its size.
			.sort((a, b) => (a.sourceKind === "" ? 1 : 0) - (b.sourceKind === "" ? 1 : 0) || b.items.length - a.items.length)
	);
}
