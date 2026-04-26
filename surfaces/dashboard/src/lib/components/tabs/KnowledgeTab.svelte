<script lang="ts">
import {
	type EntityHealth,
	type KnowledgeAspectWithCounts,
	type KnowledgeAttribute,
	type KnowledgeBaseSummary,
	type KnowledgeDependencyEdge,
	type KnowledgeEntityDetail,
	type KnowledgeEntityListItem,
	type KnowledgeStats,
	type PredictorEntitySlice,
	type PredictorProjectSlice,
	type PredictorTrainingRun,
	type TraversalStatusSnapshot,
	connectKnowledgeBaseDatabase,
	getKnowledgeAspects,
	getKnowledgeAttributes,
	getKnowledgeBases,
	getKnowledgeDependencies,
	getKnowledgeEntities,
	getKnowledgeEntity,
	getKnowledgeEntityHealth,
	getKnowledgeStats,
	getKnowledgeTraversalStatus,
	getPredictorEntitySlices,
	getPredictorProjectSlices,
	getPredictorTrainingRuns,
	importKnowledgeBase,
	pinKnowledgeEntity,
	registerCodebaseKnowledgeBase,
	registerKnowledgeBaseSource,
	unpinKnowledgeEntity,
} from "$lib/api";
import PageBanner from "$lib/components/layout/PageBanner.svelte";
import TabGroupBar from "$lib/components/layout/TabGroupBar.svelte";
import { MEMORY_TAB_ITEMS } from "$lib/components/layout/page-headers";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Calendar } from "$lib/components/ui/calendar/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import * as Popover from "$lib/components/ui/popover/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import * as Table from "$lib/components/ui/table/index.js";
import { nav } from "$lib/stores/navigation.svelte";
import { focusMemoryTab } from "$lib/stores/tab-group-focus.svelte";
import { CalendarDate, type DateValue } from "@internationalized/date";
import CalendarIcon from "@lucide/svelte/icons/calendar";
import Network from "@lucide/svelte/icons/network";
import Pin from "@lucide/svelte/icons/pin";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import { onMount } from "svelte";

const ENTITY_TYPES = ["all", "project", "person", "system", "tool", "concept", "skill", "task"] as const;

// biome-ignore lint/style/useConst: Svelte bind:value mutates $state.
let query = $state("");
// biome-ignore lint/style/useConst: Select onValueChange mutates $state.
let typeFilter = $state("all");
let loadingEntities = $state(true);
let loadingDetail = $state(false);
let loadingStats = $state(true);
let loadingTraversal = $state(true);
let loadingPredictor = $state(true);
let entities = $state<KnowledgeEntityListItem[]>([]);
let stats = $state<KnowledgeStats | null>(null);
let traversal = $state<TraversalStatusSnapshot | null>(null);
let predictorByEntity = $state<PredictorEntitySlice[]>([]);
let predictorByProject = $state<PredictorProjectSlice[]>([]);
let trainingRuns = $state<PredictorTrainingRun[]>([]);
let entityHealth = $state<EntityHealth[]>([]);
let pinBusyEntityId = $state<string | null>(null);
let knowledgeBases = $state<KnowledgeBaseSummary[]>([]);
let kbImportPath = $state("");
let kbImportName = $state("");
// biome-ignore lint/style/useConst: Select onValueChange mutates $state.
let kbImportKind = $state("filesystem");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbEntityField = $state("");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbEntityType = $state("record");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbContentField = $state("");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbDefaultAspect = $state("");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbFieldMappings = $state("");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbRelationshipMappings = $state("");
let kbDbUri = $state("");
// biome-ignore lint/style/useConst: Select onValueChange mutates $state.
let kbDbKind = $state<"sqlite" | "postgres">("sqlite");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbDbTable = $state("");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbDbPrimaryKey = $state("");
// biome-ignore lint/style/useConst: bind:value mutates $state.
let kbDbPollIntervalMs = $state("60000");
let kbCodebasePath = $state("");
let kbImportBusy = $state(false);
let kbImportMessage = $state<string | null>(null);

let selectedEntityId = $state<string | null>(null);
let selectedAspectId = $state<string | null>(null);
let entityDetail = $state<KnowledgeEntityDetail | null>(null);
let aspects = $state<KnowledgeAspectWithCounts[]>([]);
let attributes = $state<KnowledgeAttribute[]>([]);
let dependencies = $state<KnowledgeDependencyEdge[]>([]);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
// biome-ignore lint/style/useConst: Popover binding mutates $state.
let sincePickerOpen = $state(false);
const defaultSinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
// biome-ignore lint/style/useConst: Calendar selection mutates $state.
let predictorSince = $state(defaultSinceDate.toISOString().slice(0, 10));

function metricClass(kind: "default" | "warning" | "accent" = "default"): string {
	if (kind === "warning") {
		return "border-[var(--sig-warning)] text-[var(--sig-warning)]";
	}
	if (kind === "accent") {
		return "border-[var(--sig-accent)] text-[var(--sig-accent)]";
	}
	return "border-[var(--sig-border-strong)] text-[var(--sig-text)]";
}

function formatPercent(value: number): string {
	return `${value.toFixed(1)}%`;
}

function formatDate(value: string): string {
	return new Date(value).toLocaleString();
}

function formatDateOnly(value: string): string {
	return new Date(value).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

function healthForEntity(entityId: string): EntityHealth | null {
	return entityHealth.find((item) => item.entityId === entityId) ?? null;
}

function healthToneClass(entityId: string): string {
	const health = healthForEntity(entityId);
	if (!health) return "bg-[var(--sig-border-strong)]";
	if (health.trend === "declining" || health.winRate < 0.4) {
		return "bg-[var(--sig-warning)]";
	}
	if (health.trend === "improving" || health.winRate >= 0.65) {
		return "bg-[var(--sig-accent)]";
	}
	return "bg-[var(--sig-text-muted)]";
}

const maxDensityScore = $derived(
	Math.max(1, ...entities.map((e) => e.aspectCount + e.attributeCount + e.constraintCount * 2 + e.dependencyCount)),
);

function entityDensityOpacity(item: KnowledgeEntityListItem): number {
	const score = item.aspectCount + item.attributeCount + item.constraintCount * 2 + item.dependencyCount;
	return 0.08 + (score / maxDensityScore) * 0.92;
}

function toCalendarDate(value: string): DateValue | undefined {
	if (!value) return undefined;
	const parts = value.split("-");
	if (parts.length !== 3) return undefined;
	const year = Number(parts[0]);
	const month = Number(parts[1]);
	const day = Number(parts[2]);
	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
		return undefined;
	}
	return new CalendarDate(year, month, day);
}

function toIsoDate(value: DateValue | undefined): string {
	if (!value) return "";
	const year = String(value.year).padStart(4, "0");
	const month = String(value.month).padStart(2, "0");
	const day = String(value.day).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

async function loadEntities(): Promise<void> {
	loadingEntities = true;
	const result = await getKnowledgeEntities({
		query: query.trim() || undefined,
		type: typeFilter === "all" ? undefined : typeFilter,
		limit: 50,
	});
	entities = result.items;
	loadingEntities = false;
	if (selectedEntityId && !entities.some((item) => item.entity.id === selectedEntityId)) {
		selectedEntityId = null;
		selectedAspectId = null;
		entityDetail = null;
		aspects = [];
		attributes = [];
		dependencies = [];
	}
}

async function loadEntityDetail(id: string): Promise<void> {
	selectedEntityId = id;
	selectedAspectId = null;
	loadingDetail = true;
	const [detail, nextAspects, nextDependencies] = await Promise.all([
		getKnowledgeEntity(id),
		getKnowledgeAspects(id),
		getKnowledgeDependencies(id),
	]);
	entityDetail = detail;
	aspects = nextAspects;
	dependencies = nextDependencies;
	attributes = [];
	if (nextAspects.length > 0) {
		selectedAspectId = nextAspects[0].aspect.id;
		attributes = await getKnowledgeAttributes(id, nextAspects[0].aspect.id, {
			status: "active",
			limit: 50,
		});
	}
	loadingDetail = false;
}

async function loadAspect(aspectId: string): Promise<void> {
	if (!selectedEntityId) return;
	selectedAspectId = aspectId;
	attributes = await getKnowledgeAttributes(selectedEntityId, aspectId, {
		status: "active",
		limit: 50,
	});
}

async function loadStats(): Promise<void> {
	loadingStats = true;
	const [nextStats, nextHealth] = await Promise.all([
		getKnowledgeStats(),
		getKnowledgeEntityHealth({
			since: predictorSince ? new Date(`${predictorSince}T00:00:00.000Z`).toISOString() : undefined,
			minComparisons: 3,
		}),
	]);
	stats = nextStats;
	entityHealth = nextHealth;
	loadingStats = false;
}

async function loadPredictor(): Promise<void> {
	loadingPredictor = true;
	const sinceIso = predictorSince ? new Date(`${predictorSince}T00:00:00.000Z`).toISOString() : undefined;
	const [byEntity, byProject, runs] = await Promise.all([
		getPredictorEntitySlices(sinceIso),
		getPredictorProjectSlices(sinceIso),
		getPredictorTrainingRuns(20),
	]);
	predictorByEntity = byEntity;
	predictorByProject = byProject;
	trainingRuns = runs;
	loadingPredictor = false;
}

async function togglePin(entityId: string, pinned: boolean): Promise<void> {
	pinBusyEntityId = entityId;
	try {
		if (pinned) {
			await unpinKnowledgeEntity(entityId);
		} else {
			await pinKnowledgeEntity(entityId);
		}
		await loadEntities();
		if (selectedEntityId === entityId) {
			await loadEntityDetail(entityId);
		}
	} finally {
		pinBusyEntityId = null;
	}
}

function buildKnowledgeBaseMapping(): Record<string, unknown> | undefined {
	const fields: Record<string, { aspect?: string; groupKey?: string; claimKey?: string }> = {};
	for (const line of kbFieldMappings.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [field, aspect, groupKey, claimKey] = trimmed.split(":").map((part) => part?.trim() ?? "");
		if (!field) continue;
		fields[field] = { aspect: aspect || undefined, groupKey: groupKey || undefined, claimKey: claimKey || undefined };
	}
	const relationships: Array<{ sourceField?: string; targetField?: string; type?: string; reasonField?: string }> = [];
	for (const line of kbRelationshipMappings.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [sourceField, targetField, type, reasonField] = trimmed.split(":").map((part) => part?.trim() ?? "");
		if (!targetField) continue;
		relationships.push({
			sourceField: sourceField || undefined,
			targetField,
			type: type || "related_to",
			reasonField: reasonField || undefined,
		});
	}
	const mapping = {
		entity: kbEntityField.trim()
			? {
					field: kbEntityField.trim(),
					type: kbEntityType.trim() || undefined,
					aspect: kbDefaultAspect.trim() || undefined,
				}
			: undefined,
		content: kbContentField.trim() || undefined,
		aspect: kbDefaultAspect.trim() || undefined,
		fields: Object.keys(fields).length > 0 ? fields : undefined,
		relationships: relationships.length > 0 ? relationships : undefined,
	};
	return Object.values(mapping).some(Boolean) ? mapping : undefined;
}

async function refreshKnowledgeBases(): Promise<void> {
	knowledgeBases = await getKnowledgeBases().catch(() => knowledgeBases);
	void loadEntities();
}

async function importKnowledgeBaseFromPath(): Promise<void> {
	const path = kbImportPath.trim();
	if (!path || kbImportBusy) return;
	kbImportBusy = true;
	kbImportMessage = null;
	try {
		const mapping = buildKnowledgeBaseMapping();
		if (kbImportKind === "repo" || kbImportKind === "obsidian" || kbImportKind === "filesystem") {
			const result = await registerKnowledgeBaseSource({
				path,
				name: kbImportName.trim() || undefined,
				kind: kbImportKind,
				mapping,
			});
			kbImportMessage = `Registered watched source. Imported ${result.imported ?? 0} records.`;
		} else {
			const result = await importKnowledgeBase({
				path,
				name: kbImportName.trim() || undefined,
				kind: kbImportKind,
				mapping,
			});
			kbImportMessage = `Imported ${result.imported} records, ${result.attributes} attributes.`;
		}
		kbImportPath = "";
		kbImportName = "";
		await refreshKnowledgeBases();
	} catch (error) {
		kbImportMessage = error instanceof Error ? error.message : String(error);
	} finally {
		kbImportBusy = false;
	}
}

async function connectDatabaseKnowledgeBase(): Promise<void> {
	if (!kbDbUri.trim() || kbImportBusy) return;
	kbImportBusy = true;
	kbImportMessage = null;
	try {
		await connectKnowledgeBaseDatabase({
			uri: kbDbUri.trim(),
			name: kbImportName.trim() || undefined,
			kind: kbDbKind,
			config: {
				table: kbDbTable.trim() || undefined,
				primaryKey: kbDbPrimaryKey.trim() || undefined,
				pollIntervalMs: Number.parseInt(kbDbPollIntervalMs, 10) || 60_000,
			},
			mapping: buildKnowledgeBaseMapping(),
		});
		kbImportMessage = "Registered database source for polling.";
		kbDbUri = "";
		await refreshKnowledgeBases();
	} catch (error) {
		kbImportMessage = error instanceof Error ? error.message : String(error);
	} finally {
		kbImportBusy = false;
	}
}

async function registerCodebaseKnowledge(): Promise<void> {
	if (!kbCodebasePath.trim() || kbImportBusy) return;
	kbImportBusy = true;
	kbImportMessage = null;
	try {
		const result = await registerCodebaseKnowledgeBase({
			path: kbCodebasePath.trim(),
			name: kbImportName.trim() || undefined,
			mapping: buildKnowledgeBaseMapping(),
		});
		kbImportMessage = `Registered GraphIQ codebase ${result.name}.`;
		kbCodebasePath = "";
		await refreshKnowledgeBases();
	} catch (error) {
		kbImportMessage = error instanceof Error ? error.message : String(error);
	} finally {
		kbImportBusy = false;
	}
}

async function loadTraversal(): Promise<void> {
	loadingTraversal = true;
	traversal = await getKnowledgeTraversalStatus();
	loadingTraversal = false;
}

function queueEntitySearch(): void {
	if (searchTimer) clearTimeout(searchTimer);
	searchTimer = setTimeout(() => {
		loadEntities();
	}, 200);
}

let lastTraversalLoad = 0;

function refreshTraversal(): void {
	lastTraversalLoad = Date.now();
	void loadTraversal();
}

onMount(() => {
	void Promise.all([loadEntities(), loadStats(), loadPredictor()]);
	refreshTraversal();
	const onFocus = () => {
		if (Date.now() - lastTraversalLoad >= 60_000) {
			refreshTraversal();
		}
	};
	window.addEventListener("focus", onFocus);
	return () => {
		window.removeEventListener("focus", onFocus);
		if (searchTimer) clearTimeout(searchTimer);
	};
});
</script>

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
	<PageBanner title="Knowledge">
		<TabGroupBar
			group="memory"
			tabs={MEMORY_TAB_ITEMS}
			activeTab={nav.activeTab}
			onselect={(_tab, index) => focusMemoryTab(index)}
		/>
	</PageBanner>
	<div class="flex flex-col flex-1 min-h-0 overflow-auto gap-3 p-3 bg-[var(--sig-bg)]">
		<Card.Root class="border-[var(--sig-border)] bg-[var(--sig-surface)]">
			<Card.Header class="border-b border-[var(--sig-border)] pb-3">
				<Card.Title class="sig-heading flex items-center gap-2">
					<Network class="size-4" />
					Knowledge Bases
				</Card.Title>
				<Card.Description class="sig-label text-[var(--sig-text-muted)]">
					Import, watch, poll, and map external sources into scoped knowledge.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4 p-3">
				<div class="grid gap-2 lg:grid-cols-[1fr_200px_160px_auto]">
					<Input
						class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]"
						placeholder="/path/to/file, folder, repo, or vault"
						bind:value={kbImportPath}
					/>
					<Input
						class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]"
						placeholder="Name"
						bind:value={kbImportName}
					/>
					<Select.Root type="single" value={kbImportKind} onValueChange={(value) => { kbImportKind = value ?? "filesystem"; }}>
						<Select.Trigger class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]">
							{kbImportKind}
						</Select.Trigger>
						<Select.Content class="border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)]">
							{#each ["filesystem", "repo", "obsidian", "csv", "json"] as kind}
								<Select.Item value={kind} label={kind} />
							{/each}
						</Select.Content>
					</Select.Root>
					<Button class="sig-label" disabled={kbImportBusy || !kbImportPath.trim()} onclick={importKnowledgeBaseFromPath}>
						{kbImportBusy ? "Working..." : "Add source"}
					</Button>
				</div>

				<div class="grid gap-2 md:grid-cols-4">
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="Entity field" bind:value={kbEntityField} />
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="Entity type" bind:value={kbEntityType} />
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="Content field" bind:value={kbContentField} />
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="Default aspect" bind:value={kbDefaultAspect} />
				</div>
				<textarea
					class="sig-label min-h-16 w-full rounded-md border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] p-2 text-[var(--sig-text-bright)]"
					placeholder="Optional field mappings, one per line: field:aspect:groupKey:claimKey"
					bind:value={kbFieldMappings}
				></textarea>
				<textarea
					class="sig-label min-h-16 w-full rounded-md border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] p-2 text-[var(--sig-text-bright)]"
					placeholder="Optional relationship mappings, one per line: sourceField:targetField:type:reasonField"
					bind:value={kbRelationshipMappings}
				></textarea>

				<div class="grid gap-2 lg:grid-cols-[120px_1fr_180px_180px_150px_auto]">
					<Select.Root type="single" value={kbDbKind} onValueChange={(value) => { kbDbKind = value === "postgres" ? "postgres" : "sqlite"; }}>
						<Select.Trigger class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]">{kbDbKind}</Select.Trigger>
						<Select.Content class="border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)]">
							<Select.Item value="sqlite" label="sqlite" />
							<Select.Item value="postgres" label="postgres" />
						</Select.Content>
					</Select.Root>
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="Database URI or SQLite path" bind:value={kbDbUri} />
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="Table/view" bind:value={kbDbTable} />
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="Primary key" bind:value={kbDbPrimaryKey} />
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="Poll ms" bind:value={kbDbPollIntervalMs} />
					<Button class="sig-label" disabled={kbImportBusy || !kbDbUri.trim()} onclick={connectDatabaseKnowledgeBase}>Poll DB</Button>
				</div>

				<div class="grid gap-2 lg:grid-cols-[1fr_auto]">
					<Input class="sig-label border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]" placeholder="/path/to/codebase for GraphIQ registration" bind:value={kbCodebasePath} />
					<Button class="sig-label" disabled={kbImportBusy || !kbCodebasePath.trim()} onclick={registerCodebaseKnowledge}>Register codebase</Button>
				</div>

				{#if kbImportMessage}
					<p class="sig-label text-[var(--sig-text-muted)]">{kbImportMessage}</p>
				{/if}
				<div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
					{#each knowledgeBases as kb}
						<div class="rounded-md border border-[var(--sig-border)] bg-[var(--sig-surface-raised)] p-3">
							<div class="sig-heading text-[var(--sig-text-bright)]">{kb.name}</div>
							<div class="sig-label text-[var(--sig-text-muted)]">{kb.kind} · {kb.status}</div>
							{#if kb.sourceUri}
								<div class="sig-label truncate text-[var(--sig-text-muted)]">{kb.sourceUri}</div>
							{/if}
							{#if kb.lastSyncedAt}
								<div class="sig-label text-[var(--sig-text-muted)]">synced {formatDateOnly(kb.lastSyncedAt)}</div>
							{/if}
						</div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
		<Card.Root class="border-[var(--sig-border)] bg-[var(--sig-surface)]">
			<Card.Header class="border-b border-[var(--sig-border)] pb-3">
				<Card.Title class="sig-heading flex items-center gap-2">
					<Network class="size-4" />
					Entity Browser
				</Card.Title>
				<Card.Description class="sig-label text-[var(--sig-text-muted)]">
					Inspect structural entities, aspects, attributes, and dependency edges.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3 p-3">
				<div class="flex flex-col gap-2 lg:flex-row">
					<Input
						class="sig-label flex-1 border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]"
						placeholder="Search canonical entity name..."
						bind:value={query}
						oninput={queueEntitySearch}
					/>
					<Select.Root
						type="single"
						value={typeFilter}
						onValueChange={(value) => {
							typeFilter = value ?? "all";
							void loadEntities();
						}}
					>
						<Select.Trigger class="sig-label min-w-[170px] border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-bright)]">
							{typeFilter === "all" ? "All entity types" : typeFilter}
						</Select.Trigger>
						<Select.Content class="border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)]">
							{#each ENTITY_TYPES as entityType}
								<Select.Item
									value={entityType}
									label={entityType === "all" ? "All entity types" : entityType}
								/>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<div class="grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
					<div class="max-h-[520px] overflow-y-auto border border-[var(--sig-border)] bg-[var(--sig-surface)]">
						{#if loadingEntities}
							{#each Array(10) as _}
								<Skeleton class="h-9 w-full" />
							{/each}
						{:else if entities.length === 0}
							<div class="p-6 sig-label text-[var(--sig-text-muted)]">
								No entities match the current filters.
							</div>
						{:else}
							{#each entities as item (item.entity.id)}
								<button
									class="w-full cursor-pointer flex items-center gap-2.5 border-b border-b-[var(--sig-border)] px-2.5 py-2 text-left transition-colors
										{selectedEntityId === item.entity.id
											? 'bg-[var(--sig-surface-raised)]'
											: 'hover:bg-[var(--sig-surface-raised)]'}"
									style="border-left: 2px solid {selectedEntityId === item.entity.id
										? 'var(--sig-accent)'
										: `rgba(240, 240, 242, ${entityDensityOpacity(item)})`}"
									onclick={() => void loadEntityDetail(item.entity.id)}
								>
									<span class={`size-1.5 shrink-0 rounded-full ${healthToneClass(item.entity.id)}`}></span>
									<span class="sig-heading text-[11px] tracking-[0.08em] truncate min-w-0 flex-1">
										{item.entity.name}
									</span>
									{#if item.entity.pinned}
										<Pin class="size-3 shrink-0 text-[var(--sig-accent)]" />
									{/if}
									<span class="sig-meta shrink-0 text-[var(--sig-text-muted)]">
										{item.entity.entityType}
									</span>
									<span class="sig-meta shrink-0 flex items-center gap-1 tabular-nums text-[var(--sig-text-muted)]">
										<span title="aspects">{item.aspectCount}<span class="opacity-50">a</span></span>
										<span title="attributes">{item.attributeCount}<span class="opacity-50">t</span></span>
										<span class="text-[var(--sig-danger)]" title="constraints">{item.constraintCount}<span class="opacity-50">c</span></span>
										<span title="dependencies">{item.dependencyCount}<span class="opacity-50">d</span></span>
									</span>
								</button>
							{/each}
						{/if}
					</div>

					<Card.Root class="min-h-[420px] border-[var(--sig-border)] bg-[var(--sig-surface-raised)]">
						<Card.Content class="p-3">
							{#if loadingDetail}
								<div class="space-y-3">
									<Skeleton class="h-6 w-48" />
									<Skeleton class="h-24 w-full" />
									<Skeleton class="h-36 w-full" />
								</div>
							{:else if !entityDetail}
								<div class="flex h-full min-h-[360px] items-center justify-center sig-label text-[var(--sig-text-muted)]">
									Select an entity to inspect its structure.
								</div>
							{:else}
								{@const entity = entityDetail.entity}
								<div class="space-y-4">
									<div class="space-y-2 border-b border-[var(--sig-border)] pb-3">
										<div class="flex items-start justify-between gap-3">
											<div>
												<div class="flex items-center gap-2">
													<span class={`size-2 rounded-full ${healthToneClass(entity.id)}`}></span>
													<h3 class="sig-heading text-[14px] uppercase tracking-[0.08em]">
														{entity.name}
													</h3>
													{#if entity.pinned}
														<Badge variant="outline" class={metricClass("accent")}>
															pinned
														</Badge>
													{/if}
												</div>
												<p class="sig-label text-[var(--sig-text-muted)]">
													{entity.canonicalName ?? entity.name}
												</p>
											</div>
											<div class="flex items-center gap-2">
												<Badge variant="outline" class={metricClass("accent")}>
													{entity.entityType}
												</Badge>
												<Button
													variant="outline"
													size="sm"
													class="h-8 px-2"
													disabled={pinBusyEntityId === entity.id}
													onclick={() =>
														void togglePin(
															entity.id,
															entity.pinned ?? false,
														)}
												>
													<Pin class="mr-1 size-3.5" />
													{entity.pinned ? "Unpin" : "Pin"}
												</Button>
											</div>
										</div>
										<div class="flex flex-wrap gap-1.5">
											<Badge variant="outline" class={metricClass()}>
												mentions {entity.mentions ?? 0}
											</Badge>
											<Badge variant="outline" class={metricClass()}>
												in {formatDate(entity.updatedAt)}
											</Badge>
										</div>
									</div>

									<div class="grid gap-3 xl:grid-cols-2">
										<div class="space-y-2">
											<div class="sig-heading text-[12px] uppercase tracking-[0.08em]">
												Aspects
											</div>
											<div class="space-y-1.5">
												{#each aspects as aspectItem}
													<button
														class="w-full cursor-pointer border p-2 text-left transition-colors
															{selectedAspectId === aspectItem.aspect.id
																? 'border-[var(--sig-accent)] bg-[var(--sig-surface)]'
																: 'border-[var(--sig-border)] hover:border-[var(--sig-border-strong)]'}"
														onclick={() => void loadAspect(aspectItem.aspect.id)}
													>
														<div class="flex items-center justify-between gap-2">
															<span class="sig-label text-[var(--sig-text-bright)]">
																{aspectItem.aspect.name}
															</span>
															<span class="sig-label text-[var(--sig-text-muted)]">
																w {aspectItem.aspect.weight.toFixed(2)}
															</span>
														</div>
														<div class="mt-1 flex flex-wrap gap-1">
															<Badge variant="outline" class={metricClass()}>
																attr {aspectItem.attributeCount}
															</Badge>
															<Badge variant="outline" class={metricClass("warning")}>
																constraint {aspectItem.constraintCount}
															</Badge>
														</div>
													</button>
												{/each}
											</div>
										</div>

										<div class="space-y-2">
											<div class="sig-heading text-[12px] uppercase tracking-[0.08em]">
												Attributes
											</div>
											<div class="max-h-[240px] space-y-1.5 overflow-auto">
												{#if attributes.length === 0}
													<div class="border border-dashed border-[var(--sig-border)] p-3 sig-label text-[var(--sig-text-muted)]">
														No active rows for this aspect.
													</div>
												{:else}
													{#each attributes as attribute}
														<div class="border border-[var(--sig-border)] p-2">
															<div class="mb-1 flex items-center gap-1.5">
																<Badge
																	variant="outline"
																	class={metricClass(
																		attribute.kind === "constraint" ? "warning" : "default",
																	)}
																>
																	{attribute.kind}
																</Badge>
																<Badge variant="outline" class={metricClass()}>
																	imp {Math.round(attribute.importance * 100)}%
																</Badge>
															</div>
															<div class="sig-label text-[var(--sig-text-bright)]">
																{attribute.content}
															</div>
														</div>
													{/each}
												{/if}
											</div>
										</div>
									</div>

									<div class="grid gap-3 xl:grid-cols-2">
										<div class="space-y-2">
											<div class="sig-heading text-[12px] uppercase tracking-[0.08em]">
												Dependencies
											</div>
											<div class="max-h-[220px] space-y-1.5 overflow-auto">
												{#if dependencies.length === 0}
													<div class="border border-dashed border-[var(--sig-border)] p-3 sig-label text-[var(--sig-text-muted)]">
														No dependency edges recorded.
													</div>
												{:else}
													{#each dependencies as edge}
														<div class="border border-[var(--sig-border)] p-2">
															<div class="flex items-center justify-between gap-2">
																<Badge variant="outline" class={metricClass()}>
																	{edge.direction}
																</Badge>
																<span class="sig-label text-[var(--sig-text-muted)]">
																	{edge.dependencyType} · {edge.strength.toFixed(2)}
																</span>
															</div>
															<div class="mt-1 sig-label text-[var(--sig-text-bright)]">
																{edge.sourceEntityName} → {edge.targetEntityName}
															</div>
															{#if edge.reason}
																<div class="mt-1 sig-meta text-[var(--sig-text-muted)] italic">
																	{edge.reason}
																</div>
															{/if}
														</div>
													{/each}
												{/if}
											</div>
										</div>

										<div class="space-y-2">
											<div class="sig-heading text-[12px] uppercase tracking-[0.08em]">
												Structural Density
											</div>
											<div class="grid grid-cols-2 gap-2">
												<Badge variant="outline" class={metricClass()}>
													aspects {entityDetail.structuralDensity.aspectCount}
												</Badge>
												<Badge variant="outline" class={metricClass()}>
													attributes {entityDetail.structuralDensity.attributeCount}
												</Badge>
												<Badge variant="outline" class={metricClass("warning")}>
													constraints {entityDetail.structuralDensity.constraintCount}
												</Badge>
												<Badge variant="outline" class={metricClass()}>
													dependencies {entityDetail.structuralDensity.dependencyCount}
												</Badge>
											</div>
										</div>
									</div>
								</div>
							{/if}
						</Card.Content>
					</Card.Root>
				</div>
			</Card.Content>
		</Card.Root>

		<div class="grid gap-3 xl:grid-cols-[1fr_1fr]">
			<Card.Root class="border-[var(--sig-border)] bg-[var(--sig-surface)]">
				<Card.Header class="border-b border-[var(--sig-border)] pb-3">
					<div class="flex items-center justify-between gap-2">
						<div>
							<Card.Title class="sig-heading text-[13px] uppercase tracking-[0.08em]">
								Traversal Status
							</Card.Title>
							<Card.Description class="sig-label text-[var(--sig-text-muted)]">
								Latest structural walk emitted by session-start or recall.
							</Card.Description>
						</div>
						<Button variant="outline" size="sm" class="h-8 px-2" onclick={() => refreshTraversal()}>
							<RefreshCw class="size-3.5" />
						</Button>
					</div>
				</Card.Header>
				<Card.Content class="space-y-3 p-3">
					{#if loadingTraversal}
						<Skeleton class="h-28 w-full" />
					{:else if !traversal}
						<div class="border border-dashed border-[var(--sig-border)] p-4 sig-label text-[var(--sig-text-muted)]">
							No traversal snapshot recorded yet.
						</div>
					{:else}
						<div class="flex flex-wrap gap-1.5">
							<Badge variant="outline" class={metricClass("accent")}>
								{traversal.phase}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								source {traversal.source ?? "unknown"}
							</Badge>
							{#if traversal.timedOut}
								<Badge variant="outline" class={metricClass("warning")}>
									timeout
								</Badge>
							{/if}
						</div>
						<div class="sig-label text-[var(--sig-text-bright)]">
							{traversal.focalEntityNames.length > 0
								? traversal.focalEntityNames.join(", ")
								: "No focal entities resolved"}
						</div>
						<div class="grid grid-cols-2 gap-2 xl:grid-cols-4">
							<Badge variant="outline" class={metricClass()}>
								focal {traversal.focalEntities}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								traversed {traversal.traversedEntities}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								memories {traversal.memoryCount}
							</Badge>
							<Badge variant="outline" class={metricClass("warning")}>
								constraints {traversal.constraintCount}
							</Badge>
						</div>
						<div class="sig-label text-[var(--sig-text-muted)]">
							Last run: {formatDate(traversal.at)}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root class="border-[var(--sig-border)] bg-[var(--sig-surface)]">
				<Card.Header class="border-b border-[var(--sig-border)] pb-3">
					<Card.Title class="sig-heading text-[13px] uppercase tracking-[0.08em]">
						Knowledge Stats
					</Card.Title>
					<Card.Description class="sig-label text-[var(--sig-text-muted)]">
						Coverage of structural assignment plus predictor comparison slices.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4 p-3">
					{#if loadingStats}
						<Skeleton class="h-40 w-full" />
					{:else if !stats}
						<div class="border border-dashed border-[var(--sig-border)] p-4 sig-label text-[var(--sig-text-muted)]">
							Knowledge stats unavailable.
						</div>
					{:else}
						<div class="grid grid-cols-2 gap-2 xl:grid-cols-3">
							<Badge variant="outline" class={metricClass()}>
								entities {stats.entityCount}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								aspects {stats.aspectCount}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								attributes {stats.attributeCount}
							</Badge>
							<Badge variant="outline" class={metricClass("warning")}>
								constraints {stats.constraintCount}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								dependencies {stats.dependencyCount}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								unassigned {stats.unassignedMemoryCount}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								feedback 7d {stats.feedbackUpdatedAspectCount}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								avg weight {stats.averageAspectWeight.toFixed(2)}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								maxed {stats.maxWeightAspectCount}
							</Badge>
							<Badge variant="outline" class={metricClass()}>
								min floor {stats.minWeightAspectCount}
							</Badge>
						</div>

						<div class="space-y-2">
							<div class="flex items-center justify-between sig-label">
								<span class="text-[var(--sig-text-muted)]">Structural coverage</span>
								<span class="text-[var(--sig-text-bright)]">{formatPercent(stats.coveragePercent)}</span>
							</div>
							<div class="h-2 border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)]">
								<div
									class="h-full bg-[var(--sig-accent)]"
									style={`width: ${Math.min(Math.max(stats.coveragePercent, 0), 100)}%`}
								></div>
							</div>
						</div>

					{/if}
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root class="border-[var(--sig-border)] bg-[var(--sig-surface)]">
			<Card.Header class="border-b border-[var(--sig-border)] pb-3">
				<div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
					<div>
						<Card.Title class="sig-heading text-[13px] uppercase tracking-[0.08em]">
							Predictor Slices
						</Card.Title>
						<Card.Description class="sig-label text-[var(--sig-text-muted)]">
							Project and entity comparison slices plus recent training runs.
						</Card.Description>
					</div>
					<div class="flex items-center gap-2">
						<Popover.Root bind:open={sincePickerOpen}>
							<Popover.Trigger>
								{#snippet child({ props })}
									<button
										{...props}
										class="sig-label inline-flex min-w-[170px] items-center justify-between gap-2 border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] px-2 py-1 text-[var(--sig-text-bright)]"
									>
										<span>Since {formatDateOnly(`${predictorSince}T00:00:00.000Z`)}</span>
										<CalendarIcon class="size-3 shrink-0 opacity-70" />
									</button>
								{/snippet}
							</Popover.Trigger>
							<Popover.Content
								class="w-auto overflow-hidden border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] p-0"
								align="end"
							>
								<Calendar
									type="single"
									captionLayout="dropdown"
									value={toCalendarDate(predictorSince)}
									onValueChange={(value: DateValue | undefined) => {
										predictorSince = toIsoDate(value);
										sincePickerOpen = false;
										void Promise.all([loadPredictor(), loadStats()]);
									}}
									class="bg-[var(--sig-surface-raised)] p-2 text-[var(--sig-text)]"
								/>
							</Popover.Content>
						</Popover.Root>
						<Button
							variant="outline"
							size="sm"
							class="h-8 px-2"
							onclick={() => void Promise.all([loadPredictor(), loadStats()])}
						>
							<RefreshCw class="size-3.5" />
						</Button>
					</div>
				</div>
			</Card.Header>
			<Card.Content class="space-y-4 p-3">
				{#if loadingPredictor}
					<Skeleton class="h-64 w-full" />
				{:else}
					<div class="grid gap-4 xl:grid-cols-2">
						<div class="space-y-2">
							<div class="sig-heading text-[12px] uppercase tracking-[0.08em]">
								By Project
							</div>
							{#if predictorByProject.length === 0}
								<div class="border border-dashed border-[var(--sig-border)] p-3 sig-label text-[var(--sig-text-muted)]">
									No predictor comparisons yet. Comparisons appear after the predictive scorer completes its first session.
								</div>
							{:else}
								<div class="overflow-x-auto border border-[var(--sig-border)]">
									<Table.Root>
										<Table.Header>
											<Table.Row>
												<Table.Head>Project</Table.Head>
												<Table.Head>Wins</Table.Head>
												<Table.Head>Losses</Table.Head>
												<Table.Head>Win Rate</Table.Head>
												<Table.Head>Avg Margin</Table.Head>
											</Table.Row>
										</Table.Header>
										<Table.Body>
											{#each predictorByProject as slice}
												<Table.Row>
													<Table.Cell>{slice.project}</Table.Cell>
													<Table.Cell>{slice.wins}</Table.Cell>
													<Table.Cell>{slice.losses}</Table.Cell>
													<Table.Cell>
														<div class="flex min-w-[120px] items-center gap-2">
															<div class="h-2 flex-1 border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)]">
																<div
																	class="h-full bg-[var(--sig-accent)]"
																	style={`width: ${Math.min(Math.max(slice.winRate * 100, 0), 100)}%`}
																></div>
															</div>
															<span>{(slice.winRate * 100).toFixed(1)}%</span>
														</div>
													</Table.Cell>
													<Table.Cell>{slice.avgMargin.toFixed(2)}</Table.Cell>
												</Table.Row>
											{/each}
										</Table.Body>
									</Table.Root>
								</div>
							{/if}
						</div>

						<div class="space-y-2">
							<div class="sig-heading text-[12px] uppercase tracking-[0.08em]">
								By Entity
							</div>
							{#if predictorByEntity.length === 0}
								<div class="border border-dashed border-[var(--sig-border)] p-3 sig-label text-[var(--sig-text-muted)]">
									No predictor comparisons yet. Comparisons appear after the predictive scorer completes its first session.
								</div>
							{:else}
								<div class="overflow-x-auto border border-[var(--sig-border)]">
									<Table.Root>
										<Table.Header>
											<Table.Row>
												<Table.Head>Entity</Table.Head>
												<Table.Head>Wins</Table.Head>
												<Table.Head>Losses</Table.Head>
												<Table.Head>Win Rate</Table.Head>
												<Table.Head>Avg Margin</Table.Head>
											</Table.Row>
										</Table.Header>
										<Table.Body>
											{#each predictorByEntity as slice}
												<Table.Row>
													<Table.Cell>{slice.entityName}</Table.Cell>
													<Table.Cell>{slice.wins}</Table.Cell>
													<Table.Cell>{slice.losses}</Table.Cell>
													<Table.Cell>{(slice.winRate * 100).toFixed(1)}%</Table.Cell>
													<Table.Cell>{slice.avgMargin.toFixed(2)}</Table.Cell>
												</Table.Row>
											{/each}
										</Table.Body>
									</Table.Root>
								</div>
							{/if}
						</div>
					</div>

					<div class="space-y-2">
						<div class="sig-heading text-[12px] uppercase tracking-[0.08em]">
							Training Log
						</div>
						{#if trainingRuns.length === 0}
							<div class="border border-dashed border-[var(--sig-border)] p-3 sig-label text-[var(--sig-text-muted)]">
								No predictor comparisons yet. Comparisons appear after the predictive scorer completes its first session.
							</div>
						{:else}
							<div class="overflow-x-auto border border-[var(--sig-border)]">
								<Table.Root>
									<Table.Header>
										<Table.Row>
											<Table.Head>Version</Table.Head>
											<Table.Head>Loss</Table.Head>
											<Table.Head>Samples</Table.Head>
											<Table.Head>Duration</Table.Head>
											<Table.Head>Canary NDCG</Table.Head>
											<Table.Head>Date</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each trainingRuns as run}
											<Table.Row>
												<Table.Cell>v{run.modelVersion}</Table.Cell>
												<Table.Cell>{run.loss.toFixed(4)}</Table.Cell>
												<Table.Cell>{run.sampleCount}</Table.Cell>
												<Table.Cell>{formatDuration(run.durationMs)}</Table.Cell>
												<Table.Cell>
													{run.canaryNdcg === null ? "—" : run.canaryNdcg.toFixed(4)}
												</Table.Cell>
												<Table.Cell>{formatDate(run.createdAt)}</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>
						{/if}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
