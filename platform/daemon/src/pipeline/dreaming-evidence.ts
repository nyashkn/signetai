import type { EpisodicSourceRecord } from "../episodic-sources";

/** A rendered immutable source record that a Dreaming agent may cite. */
export interface DreamingAgentEvidence {
	/** Canonical episodic selector (`memory:<id>`, `artifact:<id>`, etc.). */
	readonly sourceRef: string;
	/** Canonical rendered evidence the quote must be an exact substring of. */
	readonly content: string;
	/** Provenance tuple stamped onto derived rows (source entry provenance). */
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	/** Configured Signet source entry id, when known. */
	readonly sourceEntryId: string | null;
}

/** One exact, resumable slice of immutable episodic evidence. */
export interface DreamingEvidenceFragment {
	readonly source: EpisodicSourceRecord;
	/** The exact text exposed to the agent and accepted for citations. */
	readonly content: string;
	/** Character offsets into renderDreamingEvidence(source). */
	readonly start: number;
	readonly end: number;
	readonly sourceLength: number;
}

/**
 * Return the next safe-boundary fragment without dropping or normalizing a
 * character. The cursor stores absolute offsets, so a later pass can resume
 * even if the configured context budget changes.
 */
export function nextDreamingEvidenceFragment(
	source: EpisodicSourceRecord,
	start: number,
	maxChars: number,
): DreamingEvidenceFragment | null {
	const content = renderDreamingEvidence(source);
	if (!Number.isSafeInteger(start) || start < 0 || start >= content.length || maxChars <= 0) return null;
	const cappedEnd = Math.min(content.length, start + Math.floor(maxChars));
	let end = cappedEnd;
	if (cappedEnd < content.length) {
		for (let index = cappedEnd - 1; index > start; index -= 1) {
			const character = content[index]!;
			const previous = content[index - 1]!;
			if ((character === "\n" && previous === "\n") || (/\s/.test(character) && /[.!?]/.test(previous))) {
				let boundaryEnd = index + 1;
				while (boundaryEnd < content.length && /\s/.test(content[boundaryEnd]!)) boundaryEnd += 1;
				if (boundaryEnd <= cappedEnd && content.slice(start, boundaryEnd).trim().length > 0) {
					end = boundaryEnd;
					break;
				}
			}
		}
	}
	return { source, content: content.slice(start, end), start, end, sourceLength: content.length };
}

export function completeDreamingEvidenceFragment(source: EpisodicSourceRecord): DreamingEvidenceFragment {
	const content = renderDreamingEvidence(source);
	return { source, content, start: 0, end: content.length, sourceLength: content.length };
}

/**
 * Render structured evidence preserved beside an immutable episodic record.
 * This is the canonical text exposed to Dreaming and accepted for citations.
 */
export function renderDreamingEvidenceMeta(evidenceMeta: string | null): string {
	if (!evidenceMeta) return "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(evidenceMeta);
	} catch {
		return "";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
	const data = parsed as { entities?: unknown[]; aspects?: unknown[] };
	const lines: string[] = [];
	if (Array.isArray(data.entities) && data.entities.length > 0) {
		lines.push("structured_entities:");
		for (const entity of data.entities) {
			if (typeof entity !== "object" || entity === null) continue;
			const value = entity as Record<string, unknown>;
			const source = typeof value.source === "string" ? value.source : "";
			const target = typeof value.target === "string" ? value.target : "";
			const relationship = typeof value.relationship === "string" ? value.relationship : "";
			if (source || target || relationship) {
				lines.push(`- ${source} ${relationship ? `[${relationship}] ` : ""}${target}`.trim());
			}
		}
	}
	if (Array.isArray(data.aspects) && data.aspects.length > 0) {
		lines.push("structured_aspects:");
		for (const aspect of data.aspects) {
			if (typeof aspect !== "object" || aspect === null) continue;
			const value = aspect as Record<string, unknown>;
			const entityName = typeof value.entityName === "string" ? value.entityName : "";
			const aspectName = typeof value.aspect === "string" ? value.aspect : "";
			if (entityName || aspectName) lines.push(`- ${entityName}/${aspectName}`.trim());
		}
	}
	return lines.length > 0 ? `structured_evidence:\n${lines.join("\n")}` : "";
}

/** The complete immutable evidence text Dreaming presents and citation checks. */
export function renderDreamingEvidence(source: EpisodicSourceRecord): string {
	const metadata = renderDreamingEvidenceMeta(source.evidenceMeta);
	return metadata ? `${source.content}\n${metadata}` : source.content;
}

/**
 * Convert the exact evidence passed to a Dreaming session into citation
 * records. The content is deliberately rendered here, once, so agents and
 * the write tool validate against the same structured text.
 */
export function createDreamingAgentEvidence(
	evidence: readonly (EpisodicSourceRecord | DreamingEvidenceFragment)[],
): readonly DreamingAgentEvidence[] {
	return evidence.map((item) => {
		const fragment = "source" in item ? item : completeDreamingEvidenceFragment(item);
		const { source } = fragment;
		return {
		sourceRef: `${source.kind}:${source.id}`,
		content: fragment.content,
		sourceKind: source.sourceKind,
		sourceId: source.sourceId,
		sourcePath: source.sourcePath,
		sourceEntryId: source.sourceEntryId,
		};
	});
}
