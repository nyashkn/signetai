<script lang="ts">
import {
	type OntologyProposalRecord,
	applyOntologyProposal,
	listOntologyProposals,
	rejectOntologyProposal,
} from "$lib/api";
import { Check, ChevronDown, RefreshCw, X } from "$lib/icons";
import { proposalHeadline, proposalEvidenceLines } from "./proposal-inbox-data";

interface Props {
	agentId?: string;
}
const { agentId = "default" }: Props = $props();

let proposals = $state<OntologyProposalRecord[]>([]);
let loading = $state(false);
let loadError = $state<string | null>(null);
let busyId = $state<string | null>(null);
let rowError = $state<Record<string, string>>({});
let expanded = $state<Record<string, boolean>>({});

async function load(): Promise<void> {
	loading = true;
	loadError = null;
	try {
		proposals = await listOntologyProposals(agentId, "pending", 100);
	} catch (err) {
		loadError = err instanceof Error ? err.message : "Could not load proposals";
	} finally {
		loading = false;
	}
}

// Re-runs whenever the inspected agent changes.
$effect(() => {
	void agentId;
	void load();
});

async function decide(proposal: OntologyProposalRecord, decision: "apply" | "reject"): Promise<void> {
	busyId = proposal.id;
	const result =
		decision === "apply"
			? await applyOntologyProposal(agentId, proposal.id)
			: await rejectOntologyProposal(agentId, proposal.id, "rejected from dashboard");
	busyId = null;
	if (!result.ok) {
		rowError = { ...rowError, [proposal.id]: result.error ?? "Failed" };
		return;
	}
	// The row leaves the pending queue either way, so drop it rather than refetch.
	const { [proposal.id]: _dropped, ...rest } = rowError;
	rowError = rest;
	proposals = proposals.filter((item) => item.id !== proposal.id);
}
</script>

<section class="inbox">
	<header>
		<h2>Proposals<span class="count">{proposals.length}</span></h2>
		<button type="button" class="icon" onclick={() => load()} disabled={loading} aria-label="Refresh proposals">
			<RefreshCw size={13} class={loading ? "spin" : ""} />
		</button>
	</header>

	{#if loadError}
		<p class="empty error">{loadError}</p>
	{:else if loading && proposals.length === 0}
		<p class="empty">Loading…</p>
	{:else if proposals.length === 0}
		<p class="empty">Nothing pending.</p>
	{/if}

	<ul>
		{#each proposals as proposal (proposal.id)}
			{@const evidence = proposalEvidenceLines(proposal)}
			<li>
				<div class="row">
					<span class="operation">{proposal.operation.replace(/_/g, " ")}</span>
					<span class="confidence" class:low={proposal.confidence < 0.6}>
						{Math.round(proposal.confidence * 100)}%
					</span>
					{#if proposal.risk}<span class="risk">{proposal.risk}</span>{/if}
				</div>

				<p class="headline">{proposalHeadline(proposal)}</p>
				{#if proposal.rationale}<p class="rationale">{proposal.rationale}</p>{/if}

				{#if evidence.length > 0}
					<button type="button" class="evidence-toggle" onclick={() => (expanded = { ...expanded, [proposal.id]: !expanded[proposal.id] })}>
						<ChevronDown size={11} class={expanded[proposal.id] ? "open" : ""} />
						{evidence.length} evidence
					</button>
					{#if expanded[proposal.id]}
						<ul class="evidence">
							{#each evidence as line, index (index)}
								<li>{line}</li>
							{/each}
						</ul>
					{/if}
				{/if}

				{#if rowError[proposal.id]}<p class="row-error">{rowError[proposal.id]}</p>{/if}

				<div class="actions">
					<button type="button" class="apply" disabled={busyId === proposal.id} onclick={() => decide(proposal, "apply")}>
						<Check size={12} /> Apply
					</button>
					<button type="button" class="reject" disabled={busyId === proposal.id} onclick={() => decide(proposal, "reject")}>
						<X size={12} /> Reject
					</button>
				</div>
			</li>
		{/each}
	</ul>
</section>

<style>
	.inbox {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		width: 320px;
		border-left: 1px solid rgba(148, 163, 184, 0.16);
		background: #05070f;
		color: #cbd5f5;
		font-size: 12px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.14);
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #94a3b8;
	}
	.count {
		padding: 1px 6px;
		border-radius: 999px;
		background: rgba(212, 160, 23, 0.16);
		color: #d4a017;
		font-size: 11px;
	}
	.icon {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border: none;
		border-radius: 5px;
		background: transparent;
		color: #64748b;
		cursor: pointer;
	}
	.icon:hover:not(:disabled) {
		background: rgba(148, 163, 184, 0.12);
		color: #cbd5f5;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		/* `min-height: 0` is what actually makes this scroll: a flex item's
		   default `min-height: auto` sizes it to its content, so the list grew
		   past the panel and every row below the fold became unclickable. */
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.evidence {
		flex: none;
		overflow: visible;
	}
	li {
		padding: 10px 12px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.08);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 5px;
	}
	.operation {
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #64748b;
	}
	.confidence {
		font-variant-numeric: tabular-nums;
		font-size: 10px;
		color: #34d399;
	}
	.confidence.low {
		color: #d4a017;
	}
	.risk {
		font-size: 10px;
		color: #f87171;
	}
	.headline {
		margin: 0 0 4px;
		color: #e2e8f0;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	.rationale {
		margin: 0 0 6px;
		color: #64748b;
		font-size: 11px;
		line-height: 1.4;
	}
	.evidence-toggle {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 0;
		border: none;
		background: transparent;
		color: #64748b;
		font-size: 11px;
		cursor: pointer;
	}
	.evidence-toggle:hover {
		color: #cbd5f5;
	}
	.evidence {
		margin: 4px 0 0;
		padding-left: 10px;
		border-left: 1px solid rgba(148, 163, 184, 0.18);
	}
	.evidence li {
		padding: 2px 0;
		border: none;
		color: #94a3b8;
		font-size: 11px;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		gap: 6px;
		margin-top: 8px;
	}
	.actions button {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 9px;
		border: 1px solid transparent;
		border-radius: 5px;
		background: rgba(148, 163, 184, 0.1);
		color: #cbd5f5;
		font-size: 11px;
		cursor: pointer;
	}
	.actions button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.actions .apply:hover:not(:disabled) {
		border-color: rgba(52, 211, 153, 0.5);
		color: #34d399;
	}
	.actions .reject:hover:not(:disabled) {
		border-color: rgba(248, 113, 113, 0.5);
		color: #f87171;
	}
	.empty {
		margin: 0;
		padding: 14px 12px;
		color: #64748b;
	}
	.empty.error {
		color: #f87171;
	}
	.row-error {
		margin: 6px 0 0;
		color: #f87171;
		font-size: 11px;
		line-height: 1.4;
	}
	:global(.inbox .spin) {
		animation: spin 0.9s linear infinite;
	}
	:global(.inbox .open) {
		transform: rotate(180deg);
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
