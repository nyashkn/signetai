import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
	applyOntologyProposal,
	listOntologyProposals,
	rejectOntologyProposal,
	scanForDuplicateIdentities,
	type OntologyProposalRecord,
} from "@/lib/ontology-api";
import { proposalEvidenceLines, proposalHeadline } from "./proposal-inbox-data";

/** Anything above this reads as a machine-certain claim; below it, a guess. */
const HIGH_CONFIDENCE = 0.8;

function confidenceLabel(confidence: number): { text: string; tone: string } {
	if (confidence >= HIGH_CONFIDENCE) return { text: "high", tone: "text-[oklch(0.8_0.15_150)]" };
	if (confidence >= 0.55) return { text: "medium", tone: "text-[oklch(0.82_0.14_85)]" };
	return { text: "low", tone: "text-muted-foreground" };
}

/**
 * Pending ontology proposals, docked opposite the entity drawer. Merges are
 * destructive and irreversible, so they are the one operation that never
 * applies itself — this queue is the only place they are decided.
 */
export function ProposalInbox({
	agentId,
	open,
	onClose,
	onDecided,
}: {
	agentId: string;
	open: boolean;
	onClose: () => void;
	/** Applied merges rewrite aliases, so an open identity panel is stale after. */
	onDecided?: () => void;
}) {
	const [items, setItems] = useState<OntologyProposalRecord[]>([]);
	const [loading, setLoading] = useState(false);
	const [listError, setListError] = useState<string | null>(null);
	const [rowError, setRowError] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [scanning, setScanning] = useState(false);
	const [scanNote, setScanNote] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setListError(null);
		try {
			setItems(await listOntologyProposals(agentId, "pending", 50));
		} catch (err) {
			setListError(err instanceof Error ? err.message : "Proposals unavailable");
		} finally {
			setLoading(false);
		}
	}, [agentId]);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	const decide = async (id: string, decision: "apply" | "reject") => {
		setBusy(id);
		setRowError((prev) => {
			const next = { ...prev };
			delete next[id];
			return next;
		});
		const result =
			decision === "apply" ? await applyOntologyProposal(agentId, id) : await rejectOntologyProposal(agentId, id);
		setBusy(null);
		if (!result.ok) {
			// A refused decision reports against its own row — the rest of the
			// queue is still actionable and reloading would hide the reason.
			setRowError((prev) => ({ ...prev, [id]: result.error ?? "Decision failed" }));
			return;
		}
		setItems((prev) => prev.filter((item) => item.id !== id));
		onDecided?.();
	};

	const scan = async () => {
		setScanning(true);
		setScanNote(null);
		const result = await scanForDuplicateIdentities(agentId, 40);
		setScanning(false);
		if (!result.ok) {
			setScanNote(result.error ?? "Scan failed");
			return;
		}
		const written = result.written ?? 0;
		// Found-but-not-written is the generator refusing an unsafe merge. Folding
		// that into "nothing new" reads as a silent failure.
		const blocked = Math.max(0, (result.found ?? 0) - written);
		setScanNote(
			written > 0
				? `${written} new candidate${written === 1 ? "" : "s"}${blocked > 0 ? `, ${blocked} blocked` : ""}`
				: `No new candidates${blocked > 0 ? `, ${blocked} blocked` : ""}`,
		);
		if (written > 0) await load();
	};

	return (
		<aside className={cn("graph-inbox", open && "show")} aria-label="Ontology review queue">
			<header className="oi-head">
				<div className="min-w-0 flex-1">
					<span className="gr-label">Review queue</span>
					<div className="gr-title">
						{items.length} pending
						{loading && <span className="ml-2 font-normal text-[11px] text-muted-foreground">loading…</span>}
					</div>
				</div>
				<button type="button" className="oi-btn" disabled={scanning} onClick={() => void scan()}>
					{scanning ? "Scanning…" : "Scan"}
				</button>
				<button type="button" className="gr-close" aria-label="Close review queue" onClick={onClose}>
					<svg
						viewBox="0 0 24 24"
						width="15"
						height="15"
						fill="none"
						stroke="currentColor"
						strokeWidth={2}
						strokeLinecap="round"
					>
						<title>Close</title>
						<path d="M18 6 6 18M6 6l12 12" />
					</svg>
				</button>
			</header>

			{scanNote && <p className="oi-note">{scanNote}</p>}
			{listError && <p className="oi-note oi-note--bad">{listError}</p>}

			{/* min-h-0 is load-bearing: a flex item defaults to min-height:auto, so
			    overflow-y alone leaves the list overflowing and unclickable. */}
			<div className="oi-list min-h-0">
				{!loading && items.length === 0 && !listError && (
					<p className="oi-empty">Nothing pending. Scan looks for duplicate identities the graph has not merged.</p>
				)}
				{items.map((proposal) => {
					const confidence = confidenceLabel(proposal.confidence);
					// Evidence lines are literal quotes with no id of their own and the
					// list never reorders, so position is the identity.
					const evidence = proposalEvidenceLines(proposal).map((text, i) => ({ id: `${proposal.id}:${i}`, text }));
					const isOpen = expanded === proposal.id;
					return (
						<article key={proposal.id} className="oi-row">
							<div className="oi-row-top">
								<code className="oi-op">{proposal.operation}</code>
								<span className={cn("oi-conf", confidence.tone)}>
									{confidence.text} · {Math.round(proposal.confidence * 100)}%
								</span>
							</div>
							<p className="oi-headline">{proposalHeadline(proposal)}</p>
							{proposal.rationale && <p className="oi-rationale">{proposal.rationale}</p>}

							{evidence.length > 0 && (
								<>
									<button
										type="button"
										className="oi-eviclose"
										onClick={() => setExpanded(isOpen ? null : proposal.id)}
										aria-expanded={isOpen}
									>
										{isOpen ? "Hide" : "Show"} evidence ({evidence.length})
									</button>
									{isOpen && (
										<ul className="oi-evidence">
											{evidence.map((line) => (
												<li key={line.id}>{line.text}</li>
											))}
										</ul>
									)}
								</>
							)}

							{rowError[proposal.id] && <p className="oi-note oi-note--bad">{rowError[proposal.id]}</p>}

							<div className="oi-actions">
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
						</article>
					);
				})}
			</div>
		</aside>
	);
}
