/**
 * Identity + ontology client. Kept out of `api.ts` deliberately: that file is
 * upstream's and this fork re-merges against it, so the identity surface lives
 * beside it rather than inside it.
 *
 * Every request carries `authHeaders()` — the alias routes sit behind the same
 * daemon auth guard as everything else, and a `local`-mode daemon simply
 * ignores the header.
 */

import { authHeaders } from "@/lib/api";

const API_BASE = "";

function jsonHeaders(): HeadersInit {
	return { "Content-Type": "application/json", Accept: "application/json", ...authHeaders() };
}

export interface EntityAliasRecord {
	id: string;
	entityId: string;
	alias: string;
	canonicalAlias: string;
	aliasKind?: string | null;
	confidence: number;
	source: string | null;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
}

export interface TouchedItemRecord {
	entityId: string;
	name: string;
	entityType: string;
	relation: string;
	strength: number;
	sourceKind: string | null;
	sourcePath: string | null;
	occurredAt: string | null;
	deepLink: string | null;
}

export interface WhatTouchedResult {
	identity: {
		entityIds: string[];
		names: string[];
		matchedVia: "id" | "name" | "alias" | "none";
	};
	items: TouchedItemRecord[];
}

export type OntologyProposalStatus = "pending" | "applied" | "rejected" | "failed";

export interface OntologyProposalRecord {
	id: string;
	operation: string;
	status: OntologyProposalStatus;
	payload: Record<string, unknown>;
	confidence: number;
	rationale: string;
	evidence: unknown[];
	risk: string | null;
	sourceKind: string | null;
	sourcePath: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

export const ALIAS_KINDS = ["email", "phone", "github_login", "clickup_member", "discord_id", "display_name"] as const;

export type AliasKind = (typeof ALIAS_KINDS)[number];

export async function getEntityAliases(agentId: string, entityId: string): Promise<EntityAliasRecord[]> {
	const params = new URLSearchParams({ agent_id: agentId, status: "active" });
	const res = await fetch(
		`${API_BASE}/api/ontology/entities/${encodeURIComponent(entityId)}/aliases?${params.toString()}`,
		{ headers: authHeaders() },
	);
	if (!res.ok) throw new Error(`Aliases unavailable (${res.status})`);
	const body = (await res.json()) as { items?: EntityAliasRecord[] };
	return body.items ?? [];
}

/**
 * Record a handle against an entity. Applies immediately — an alias is additive
 * and reversible, so it follows the apply-first rule rather than the proposal
 * queue a merge goes through. Upstream routes this through the audited
 * `create_entity_alias` operation, so the audit row exists either way.
 *
 * A `409` is the one-handle-one-entity invariant holding, and the daemon names
 * the current holder in the message, so the error is surfaced verbatim rather
 * than flattened to "failed".
 */
export async function linkEntityAlias(
	agentId: string,
	entityId: string,
	input: { alias: string; aliasKind: string; source?: string },
): Promise<{ ok: true; item: EntityAliasRecord } | { ok: false; error: string }> {
	const params = new URLSearchParams({ agent_id: agentId });
	const res = await fetch(
		`${API_BASE}/api/ontology/entities/${encodeURIComponent(entityId)}/aliases?${params.toString()}`,
		{
			method: "POST",
			headers: jsonHeaders(),
			body: JSON.stringify({
				alias: input.alias,
				alias_kind: input.aliasKind,
				source: input.source ?? "operator: dashboard",
			}),
		},
	);
	const body = (await res.json().catch(() => ({}))) as { item?: EntityAliasRecord; error?: string };
	if (!res.ok || !body.item) return { ok: false, error: body.error ?? `Link failed (${res.status})` };
	return { ok: true, item: body.item };
}

export async function archiveEntityAlias(
	agentId: string,
	entityId: string,
	aliasId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const params = new URLSearchParams({ agent_id: agentId });
	const res = await fetch(
		`${API_BASE}/api/ontology/entities/${encodeURIComponent(entityId)}/aliases/${encodeURIComponent(aliasId)}?${params.toString()}`,
		{ method: "DELETE", headers: authHeaders() },
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: body.error ?? `Unlink failed (${res.status})` };
	}
	return { ok: true };
}

/**
 * `who` accepts an entity id as readily as a name — identity resolution folds
 * every alias in, so the panel passes the id it already has and never has to
 * guess which spelling the graph is keyed on.
 */
export async function getWhatTouched(agentId: string, who: string, limit = 40): Promise<WhatTouchedResult> {
	const params = new URLSearchParams({ agent_id: agentId, who, limit: String(limit) });
	const res = await fetch(`${API_BASE}/api/knowledge/touched?${params.toString()}`, { headers: authHeaders() });
	if (!res.ok) throw new Error(`Trail unavailable (${res.status})`);
	return (await res.json()) as WhatTouchedResult;
}

export async function listOntologyProposals(
	agentId: string,
	status: OntologyProposalStatus = "pending",
	limit = 50,
): Promise<OntologyProposalRecord[]> {
	const params = new URLSearchParams({ agent_id: agentId, status, limit: String(limit) });
	const res = await fetch(`${API_BASE}/api/ontology/proposals?${params.toString()}`, { headers: authHeaders() });
	if (!res.ok) throw new Error(`Proposals unavailable (${res.status})`);
	const body = (await res.json()) as { items?: OntologyProposalRecord[] };
	return body.items ?? [];
}

/**
 * Apply or reject, which are the same request with a different verb in the path.
 * The daemon answers a refused decision with a JSON `error` and a 4xx — a merge
 * whose target has since been renamed, say — so the message is returned rather
 * than thrown: the inbox shows it against the row it belongs to.
 */
async function decideOntologyProposal(
	agentId: string,
	id: string,
	decision: "apply" | "reject",
	reason?: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(`${API_BASE}/api/ontology/proposals/${encodeURIComponent(id)}/${decision}`, {
			method: "POST",
			headers: jsonHeaders(),
			body: JSON.stringify({ agent_id: agentId, actor: "dashboard", ...(reason ? { reason } : {}) }),
		});
		const body = (await res.json().catch(() => null)) as { error?: string; status?: string } | null;
		if (!res.ok) return { ok: false, error: body?.error ?? `Request failed (${res.status})` };
		// `applied` is written inside the same transaction as the mutation, so any
		// other status means the operation itself failed and left the graph alone.
		if (decision === "apply" && body?.status !== "applied") {
			return { ok: false, error: body?.error ?? `Proposal ended as ${body?.status ?? "unknown"}` };
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Request failed" };
	}
}

export function applyOntologyProposal(agentId: string, id: string): Promise<{ ok: boolean; error?: string }> {
	return decideOntologyProposal(agentId, id, "apply");
}

export function rejectOntologyProposal(
	agentId: string,
	id: string,
	reason?: string,
): Promise<{ ok: boolean; error?: string }> {
	return decideOntologyProposal(agentId, id, "reject", reason);
}

/**
 * Nothing schedules the duplicate generator from the UI side — it is a manual
 * repair pass, and until it is asked to write, `proposeDuplicateEntityMerges`
 * is a dry run whose candidates are thrown away. That is why the queue reads
 * empty on a graph that has a dozen obvious duplicates in it.
 */
export async function scanForDuplicateIdentities(
	agentId: string,
	limit = 40,
): Promise<{ ok: boolean; written?: number; found?: number; skipped?: number; error?: string }> {
	try {
		const res = await fetch(`${API_BASE}/api/ontology/proposals/repair/duplicates`, {
			method: "POST",
			headers: jsonHeaders(),
			body: JSON.stringify({ agent_id: agentId, limit, write_proposals: true, created_by: "dashboard" }),
		});
		const body = (await res.json().catch(() => null)) as {
			error?: string;
			count?: number;
			writtenCount?: number;
			skippedCount?: number;
		} | null;
		if (!res.ok) return { ok: false, error: body?.error ?? `Scan failed (${res.status})` };
		return {
			ok: true,
			written: body?.writtenCount ?? 0,
			found: body?.count ?? 0,
			skipped: body?.skippedCount ?? 0,
		};
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Scan failed" };
	}
}

/**
 * A hand-made merge goes through the same review queue as a generated one
 * rather than mutating directly — `write_proposal` is what keeps the audit
 * trail identical, and `force` is needed because the pair a human spots is
 * usually the one whose entity types differ.
 */
export async function proposeManualMerge(
	agentId: string,
	targetEntityId: string,
	source: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(`${API_BASE}/api/ontology/proposals/repair/merge-plan`, {
			method: "POST",
			headers: jsonHeaders(),
			body: JSON.stringify({
				agent_id: agentId,
				target_entity_id: targetEntityId,
				source_entities: [source],
				force: true,
				write_proposal: true,
				created_by: "dashboard",
				rationale: "Merged by hand from the identity panel.",
			}),
		});
		const body = (await res.json().catch(() => null)) as {
			error?: string;
			blocked?: boolean;
			warnings?: string[];
		} | null;
		if (!res.ok) return { ok: false, error: body?.error ?? `Merge failed (${res.status})` };
		// A blocked plan answers 200 with its reasons and writes nothing.
		if (body?.blocked) return { ok: false, error: body.warnings?.join("; ") ?? "Merge blocked" };
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Merge failed" };
	}
}
