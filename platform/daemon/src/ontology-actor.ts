import type { TokenRole } from "./auth/types";

/**
 * Who is asking, and what they are allowed to do to the graph.
 *
 * The routes used to read `actor` from `body.actor ?? x-signet-actor ??
 * "operator"` and nowhere else, so any caller could name themselves the
 * operator — the audit trail recorded a claim, not a fact. Worse, the default
 * auth mode is `local` (unauthenticated), which made that unfixable by reading
 * harder: there was nothing to read.
 *
 * The rule here is that a caller-supplied identity can **lower** privilege but
 * never raise it:
 *
 * - A verified token wins outright. `sub` is the actor and `role` is the role;
 *   whatever the body claims is ignored.
 * - Unverified, the caller's declared type is honoured *downward*: a caller
 *   saying "I am an agent" is held to agent rules, because that is a claim
 *   against interest and there is no reason to disbelieve it.
 * - Unverified callers claiming operator get operator rules only because in
 *   `local` mode the host itself is the trust boundary — the daemon binds
 *   loopback and has no other way to tell callers apart. `verified` is false on
 *   that path so the audit never overstates what it knows.
 *
 * This is what makes the MCP tools' hard-coded `propose: true` a policy rather
 * than a fixed default: the MCP server identifies as `agent`, so it is held to
 * propose-only by the daemon, not by its own good manners.
 */
export interface ResolvedActor {
	/** Name recorded on the proposal. */
	readonly actor: string;
	readonly role: TokenRole;
	/** True when the identity came from a verified token rather than a header. */
	readonly verified: boolean;
	/** Whether this caller may apply an operation that destroys rows. */
	readonly mayApplyDestructive: boolean;
}

/**
 * Operations that delete or overwrite rows and cannot be undone by archiving.
 * These are the ones an agent may only ever propose.
 *
 * `merge_entities` hard-deletes the source entity; migration 107 records what
 * it consumed but the graph edit itself is not automatically reversed.
 * `rename_entity` rewrites the name every other spelling resolves through.
 */
export const DESTRUCTIVE_ONTOLOGY_OPERATIONS: ReadonlySet<string> = new Set([
	"merge_entities",
	"rename_entity",
	"archive_entity",
]);

export interface ActorRequestFacts {
	/** Claims from a verified token, when the request carried one. */
	readonly claims?: { readonly sub?: string; readonly role?: string } | null;
	/** `x-signet-actor` — a name, not a proof. */
	readonly headerActor?: string | null;
	/** `x-signet-actor-type` — the caller's own description of itself. */
	readonly headerActorType?: string | null;
	/** `body.actor` / `body.created_by` — same standing as the header. */
	readonly bodyActor?: string | null;
}

function asRole(value: string | null | undefined): TokenRole | null {
	return value === "admin" || value === "operator" || value === "agent" || value === "readonly" ? value : null;
}

export function resolveOntologyActor(facts: ActorRequestFacts): ResolvedActor {
	const verifiedRole = asRole(facts.claims?.role ?? null);
	const verifiedSub = facts.claims?.sub?.trim();
	if (verifiedRole !== null && verifiedSub !== undefined && verifiedSub.length > 0) {
		return {
			actor: verifiedSub,
			role: verifiedRole,
			verified: true,
			mayApplyDestructive: verifiedRole === "admin" || verifiedRole === "operator",
		};
	}

	// Unverified. `harness` is what the MCP server sends; it is an agent for
	// policy purposes regardless of the word it chose.
	const declared = facts.headerActorType?.trim().toLowerCase() ?? "";
	const claimedRole: TokenRole =
		declared === "agent" || declared === "harness" ? "agent" : declared === "readonly" ? "readonly" : "operator";
	// Header before body. Neither is proof, but `x-signet-actor` is set by the
	// client transport while `body.actor` is free-form request payload — and the
	// body field is precisely what a caller reaches for to file its work under
	// someone else's name. Recording a caller that declared itself an agent as
	// "operator" is the same audit lie the role check just closed.
	const name = facts.headerActor?.trim() || facts.bodyActor?.trim() || claimedRole;

	return {
		actor: name,
		role: claimedRole,
		verified: false,
		mayApplyDestructive: claimedRole === "operator",
	};
}

/**
 * Whether this caller may apply this operation directly, or must queue it.
 *
 * Everything additive and reversible applies for anyone — that is the
 * apply-first doctrine, and an alias is the canonical example. Only the
 * destructive set is gated.
 */
export function mayApplyOntologyOperation(actor: ResolvedActor, operation: string): boolean {
	if (!DESTRUCTIVE_ONTOLOGY_OPERATIONS.has(operation)) return true;
	return actor.mayApplyDestructive;
}
