<script lang="ts">
import {
	ALIAS_KINDS,
	type EntityAliasRecord,
	type WhatTouchedResult,
	archiveEntityAlias,
	getEntityAliases,
	getWhatTouched,
	linkEntityAlias,
	proposeManualMerge,
} from "$lib/api";
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

let handleValue = $state("");
let handleKind = $state<string>("email");
let linking = $state(false);
let handleNote = $state<string | null>(null);

async function link(): Promise<void> {
	const alias = handleValue.trim();
	if (alias.length === 0) return;
	linking = true;
	handleNote = null;
	const result = await linkEntityAlias(agentId, entityId, { alias, aliasKind: handleKind });
	linking = false;
	if (!result.ok) {
		// A 409 names the entity already holding the handle, and that name is the
		// operator's next move. Show it rather than "failed".
		handleNote = result.error;
		return;
	}
	aliases = [...aliases, result.item];
	handleValue = "";
}

async function unlink(alias: EntityAliasRecord): Promise<void> {
	handleNote = null;
	const result = await archiveEntityAlias(agentId, entityId, alias.id);
	if (!result.ok) {
		handleNote = result.error;
		return;
	}
	aliases = aliases.filter((row) => row.id !== alias.id);
}

let mergeSource = $state("");
let merging = $state(false);
let mergeNote = $state<string | null>(null);

async function merge(): Promise<void> {
	const source = mergeSource.trim();
	if (source.length === 0) return;
	merging = true;
	mergeNote = null;
	const result = await proposeManualMerge(agentId, entityId, source);
	merging = false;
	if (!result.ok) {
		mergeNote = result.error ?? "Merge failed";
		return;
	}
	// It lands in the same review queue a generated candidate does, so the panel
	// says where it went rather than pretending the graph already changed.
	mergeSource = "";
	mergeNote = "Queued for review in Proposals";
}
</script>

{#if error}
	<div class="section"><div class="section-label">IDENTITY</div><p class="identity-error">{error}</p></div>
{:else}
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
						<button
							type="button"
							class="unlink"
							title="Stop this handle resolving to this entity"
							aria-label="Unlink {alias.alias}"
							onclick={() => void unlink(alias)}
						>
							×
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		<form
			class="add-handle"
			onsubmit={(event) => {
				event.preventDefault();
				void link();
			}}
		>
			<input type="text" bind:value={handleValue} placeholder="Add a handle — address, phone, login" disabled={linking} />
			<select bind:value={handleKind} disabled={linking} aria-label="Handle kind">
				{#each ALIAS_KINDS as kind (kind)}
					<option value={kind}>{kind.replace(/_/g, " ")}</option>
				{/each}
			</select>
			<button type="submit" disabled={linking || handleValue.trim().length === 0}>Link</button>
		</form>
		{#if handleNote}<p class="merge-note">{handleNote}</p>{/if}

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

		<form
			class="merge"
			onsubmit={(event) => {
				event.preventDefault();
				void merge();
			}}
		>
			<input
				type="text"
				bind:value={mergeSource}
				placeholder="Merge another name or address into this one"
				disabled={merging}
			/>
			<button type="submit" disabled={merging || mergeSource.trim().length === 0}>Queue</button>
		</form>
		{#if mergeNote}<p class="merge-note">{mergeNote}</p>{/if}
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
	.add-handle {
		display: flex;
		gap: 4px;
		margin-top: 8px;
	}
	.add-handle input {
		flex: 1;
		min-width: 0;
		padding: 3px 7px;
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 5px;
		background: rgba(2, 4, 10, 0.6);
		color: #cbd5f5;
		font-size: 11px;
	}
	.add-handle input::placeholder {
		color: #475569;
	}
	.add-handle select {
		padding: 3px 5px;
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 5px;
		background: rgba(2, 4, 10, 0.6);
		color: #cbd5f5;
		font-size: 11px;
	}
	.add-handle button {
		padding: 3px 9px;
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 5px;
		background: rgba(148, 163, 184, 0.1);
		color: #cbd5f5;
		font-size: 11px;
		cursor: pointer;
	}
	.unlink {
		margin-left: auto;
		padding: 0 4px;
		border: none;
		background: none;
		color: #64748b;
		font-size: 13px;
		line-height: 1;
		cursor: pointer;
	}
	.unlink:hover {
		color: #f87171;
	}

	.merge {
		display: flex;
		gap: 4px;
		margin-top: 8px;
	}
	.merge input {
		flex: 1;
		min-width: 0;
		padding: 3px 7px;
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 5px;
		background: rgba(2, 4, 10, 0.6);
		color: #cbd5f5;
		font-size: 11px;
	}
	.merge input::placeholder {
		color: #475569;
	}
	.merge button {
		padding: 3px 9px;
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 5px;
		background: rgba(148, 163, 184, 0.1);
		color: #cbd5f5;
		font-size: 11px;
		cursor: pointer;
	}
	.merge button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.merge-note {
		margin: 5px 0 0;
		color: #64748b;
		font-size: 11px;
	}
</style>
