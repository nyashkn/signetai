import { useCallback, useEffect, useState } from "react";
import {
	applyOntologyProposal,
	listOntologyProposals,
	rejectOntologyProposal,
	type OntologyProposalRecord,
} from "@/lib/ontology-api";
import { proposalHeadline } from "./proposal-inbox-data";

/** Identity work is continuous but low-volume; the brief is a nudge, not a queue. */
const BRIEF_MAX_ROWS = 3;

/** Operations that are an identity decision rather than a graph edit. */
const IDENTITY_OPERATIONS = new Set(["merge_entities", "create_entity_alias", "archive_entity_alias"]);

/**
 * Pending identity decisions, inside the Daily Brief.
 *
 * The brief's answer path captures free text into a memory nothing reads. An
 * identity question does not want prose — it wants a decision, and the routes
 * for that already exist. So these rows carry Apply and Reject rather than a
 * textarea; the free-text path stays for briefs that are genuinely questions.
 *
 * Nothing renders when the queue is empty. A permanently visible empty
 * "identity" block trains the eye to skip the whole card.
 */
export function IdentityBrief({ agentId }: { agentId: string }) {
	const [items, setItems] = useState<OntologyProposalRecord[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [rowError, setRowError] = useState<Record<string, string>>({});

	const load = useCallback(async () => {
		try {
			const pending = await listOntologyProposals(agentId, "pending", 25);
			setItems(pending.filter((row) => IDENTITY_OPERATIONS.has(row.operation)));
		} catch {
			// The brief is a nudge; a daemon hiccup here must not blank the card.
			setItems([]);
		}
	}, [agentId]);

	useEffect(() => {
		void load();
	}, [load]);

	const decide = async (id: string, decision: "apply" | "reject") => {
		setBusy(id);
		const result =
			decision === "apply" ? await applyOntologyProposal(agentId, id) : await rejectOntologyProposal(agentId, id);
		setBusy(null);
		if (!result.ok) {
			setRowError((prev) => ({ ...prev, [id]: result.error ?? "Decision failed" }));
			return;
		}
		setItems((prev) => prev.filter((row) => row.id !== id));
	};

	if (items.length === 0) return null;

	return (
		<section className="id-brief">
			<div className="gr-section-label">
				Identity · {items.length} to decide
				{items.length > BRIEF_MAX_ROWS && <> (showing {BRIEF_MAX_ROWS})</>}
			</div>
			{items.slice(0, BRIEF_MAX_ROWS).map((proposal) => (
				<div key={proposal.id} className="id-brief-row">
					<div className="min-w-0 flex-1">
						<div className="id-brief-headline">{proposalHeadline(proposal)}</div>
						{proposal.rationale && <div className="id-brief-why">{proposal.rationale}</div>}
						{rowError[proposal.id] && <div className="oi-note oi-note--bad">{rowError[proposal.id]}</div>}
					</div>
					<button
						type="button"
						className="oi-btn oi-btn--apply"
						disabled={busy === proposal.id}
						onClick={() => void decide(proposal.id, "apply")}
					>
						Apply
					</button>
					<button
						type="button"
						className="oi-btn"
						disabled={busy === proposal.id}
						onClick={() => void decide(proposal.id, "reject")}
					>
						Reject
					</button>
				</div>
			))}
		</section>
	);
}
