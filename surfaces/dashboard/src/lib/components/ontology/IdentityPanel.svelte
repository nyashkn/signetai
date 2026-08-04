<script lang="ts">
import { type EntityAliasRecord, type WhatTouchedResult, getEntityAliases, getWhatTouched } from "$lib/api";
import { groupTouchedBySource, touchedTitle } from "./identity-panel-data";

interface Props {
	agentId: string;
	entityId: string;
}
const { agentId, entityId }: Props = $props();

let aliases = $state<EntityAliasRecord[]>([]);
let touched = $state<WhatTouchedResult | null>(null);
let error = $state<string | null>(null);

$effect(() => {
	const id = entityId;
	const agent = agentId;
	let cancelled = false;
	aliases = [];
	touched = null;
	error = null;
	// The id is passed rather than the name: identity resolution folds every
	// alias in either way, and an id cannot be ambiguous.
	Promise.all([getEntityAliases(agent, id), getWhatTouched(agent, id, 40)])
		.then(([loadedAliases, loadedTouched]) => {
			if (cancelled) return;
			aliases = loadedAliases;
			touched = loadedTouched;
		})
		.catch((err: unknown) => {
			if (cancelled) return;
			error = err instanceof Error ? err.message : "Identity unavailable";
		});
	return () => {
		cancelled = true;
	};
});

const groups = $derived(groupTouchedBySource(touched?.items ?? []));
const otherNames = $derived((touched?.identity.names ?? []).slice(1));
</script>

{#if error}
	<div class="section"><div class="section-label">IDENTITY</div><p class="identity-error">{error}</p></div>
{:else if aliases.length > 0 || groups.length > 0}
	<div class="section">
		<div class="section-label">
			IDENTITY
			{#if otherNames.length > 0}<span class="count-inline">{otherNames.length + 1} rows</span>{/if}
		</div>

		{#if aliases.length > 0}
			<ul class="handles">
				{#each aliases as alias (alias.id)}
					<li>
						<span class="handle">{alias.alias}</span>
						{#if alias.aliasKind}<span class="kind">{alias.aliasKind.replace(/_/g, " ")}</span>{/if}
						<span class="seen">{alias.source ?? "no source recorded"}</span>
					</li>
				{/each}
			</ul>
		{/if}

		{#each groups as group (group.sourceKind)}
			<div class="group">
				<div class="group-label">{group.label} <span class="count-inline">{group.items.length}</span></div>
				<ul class="touched">
					{#each group.items as item (item.entityId + item.relation)}
						<li>
							<span class="relation">{item.relation.replace(/_/g, " ")}</span>
							{#if item.deepLink}
								<a class="target" href={item.deepLink} title={item.name}>{touchedTitle(item.name)}</a>
							{:else}
								<span class="target plain" title={item.name}>{touchedTitle(item.name)}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
{/if}

<style>
	.section {
		padding: 10px 12px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.08);
	}
	.section-label {
		margin-bottom: 6px;
		color: #64748b;
		font-size: 10px;
		letter-spacing: 0.08em;
	}
	.count-inline {
		color: #475569;
	}
	.handles,
	.touched {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.handles li {
		display: flex;
		align-items: baseline;
		gap: 6px;
		padding: 2px 0;
		font-size: 11px;
		overflow-wrap: anywhere;
	}
	.handle {
		color: #e2e8f0;
	}
	.kind {
		color: #d4a017;
		font-size: 10px;
	}
	.seen {
		flex: 1;
		min-width: 0;
		color: #475569;
		font-size: 10px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.group {
		margin-top: 8px;
	}
	.group-label {
		margin-bottom: 3px;
		color: #64748b;
		font-size: 10px;
		letter-spacing: 0.06em;
	}
	.touched li {
		display: flex;
		gap: 6px;
		padding: 1px 0;
		font-size: 11px;
	}
	.relation {
		flex: none;
		width: 84px;
		color: #64748b;
		font-size: 10px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.target {
		flex: 1;
		min-width: 0;
		color: #38bdf8;
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.target:hover {
		text-decoration: underline;
	}
	.target.plain {
		color: #94a3b8;
	}
	.identity-error {
		margin: 0;
		color: #f87171;
		font-size: 11px;
	}
</style>
