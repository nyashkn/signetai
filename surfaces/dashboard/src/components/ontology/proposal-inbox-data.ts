import type { OntologyProposalRecord } from "@/lib/ontology-api";

/**
 * Proposal payloads are per-operation `Record<string, unknown>` — the daemon
 * validates them at apply time, not at list time — so every read here is
 * defensive and falls back to the raw payload rather than showing nothing.
 */
function str(payload: Record<string, unknown>, key: string): string | null {
	const value = payload[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function strList(payload: Record<string, unknown>, key: string): string[] {
	const value = payload[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** One line a reviewer can act on without opening the payload. */
export function proposalHeadline(proposal: OntologyProposalRecord): string {
	const payload = proposal.payload ?? {};
	switch (proposal.operation) {
		case "merge_entities": {
			const target = str(payload, "target_entity") ?? str(payload, "target_entity_id");
			const sources = strList(payload, "source_entities");
			if (target && sources.length > 0) return `${target} ← ${sources.join(", ")}`;
			break;
		}
		case "add_claim_value": {
			const entity = str(payload, "entity");
			const claim = str(payload, "claim_key");
			const value = str(payload, "value");
			if (entity && claim) return value ? `${entity} · ${claim} = ${value}` : `${entity} · ${claim}`;
			break;
		}
		case "create_link": {
			const source = str(payload, "source_entity");
			const target = str(payload, "target_entity");
			if (source && target) return `${source} —${str(payload, "link_type") ?? "related_to"}→ ${target}`;
			break;
		}
		case "create_entity": {
			const entity = str(payload, "entity") ?? str(payload, "name");
			if (entity) return entity;
			break;
		}
		default:
			break;
	}
	return JSON.stringify(payload);
}

/**
 * Evidence rows carry a `quote` — the literal header line or duplicate-name
 * sentence the generator cited. That quote is the whole reason a proposal is
 * actionable in two seconds, so it is shown verbatim and never summarised.
 */
export function proposalEvidenceLines(proposal: OntologyProposalRecord): string[] {
	const evidence = Array.isArray(proposal.evidence) ? proposal.evidence : [];
	return evidence.map((item) => {
		if (typeof item === "string") return item;
		if (item !== null && typeof item === "object") {
			const record = item as Record<string, unknown>;
			const quote = typeof record.quote === "string" ? record.quote : null;
			const source = typeof record.source_id === "string" ? record.source_id : null;
			if (quote) return source ? `${quote}  —  ${source}` : quote;
		}
		return JSON.stringify(item);
	});
}
