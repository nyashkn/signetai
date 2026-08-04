<script lang="ts">
import { ListChecks } from "$lib/icons";
import ConstellationGraph from "./ConstellationGraph.svelte";
import ProposalInbox from "./ProposalInbox.svelte";

interface Props {
	agentId?: string;
}
const { agentId = "default" }: Props = $props();

// The canvas already draws pending proposals as nodes; this is the half that
// was missing — deciding them. Off by default so the graph keeps its width.
let showInbox = $state(false);
</script>

<div class="ontology-dashboard">
	<div class="canvas">
		<ConstellationGraph {agentId} />
		<button type="button" class="inbox-toggle" class:on={showInbox} onclick={() => (showInbox = !showInbox)}>
			<ListChecks size={13} /> Proposals
		</button>
	</div>
	{#if showInbox}
		<ProposalInbox {agentId} />
	{/if}
</div>

<style>
	.ontology-dashboard {
		display: flex;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: #02040a;
	}
	.canvas {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}
	.inbox-toggle {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 5;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 5px 10px;
		border: 1px solid rgba(148, 163, 184, 0.22);
		border-radius: 6px;
		background: rgba(5, 7, 15, 0.85);
		color: #94a3b8;
		font-size: 11px;
		cursor: pointer;
	}
	.inbox-toggle:hover,
	.inbox-toggle.on {
		border-color: rgba(212, 160, 23, 0.5);
		color: #d4a017;
	}
</style>
