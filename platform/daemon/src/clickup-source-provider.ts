/**
 * ClickUp source connector.
 *
 * Artifact tree, mirroring the three connectors before it:
 *
 *     source_clickup_workspace     PivotPlanIt
 *      └─ source_clickup_space      Delivery
 *          └─ source_clickup_list    Sprint 14
 *              └─ source_clickup_task    (subtasks nest under their parent task)
 *                  └─ source_clickup_comment
 *
 * What this connector adds that email could not: **a second home for the same
 * person.** Participants are keyed on the member's email address, which is the
 * identical string the email connector keys correspondents on, so a ClickUp
 * assignee and a mail correspondent land on one entity at ingest time rather
 * than through an identity proposal anyone has to approve. That is the deferred
 * "exact identifier match across sources" generator, obtained deterministically
 * because the two sources genuinely share an identifier.
 *
 * The edge vocabulary is reused rather than extended: a task's creator is
 * `authored_by`, its assignees are `addressed_to` — the artifact was directed at
 * them, which is exactly what "activities we've given them to act on" means —
 * and its watchers are `copied_on`. No new dependency type means the trail
 * walker, the purge and the participant counters all work unchanged.
 */

import { createHash } from "node:crypto";
import {
	type ClickUpSourceSettings,
	type SignetSourceEntry,
	type SourceFailureState,
	parseClickUpSettings,
} from "@signet/core";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import {
	type ClickUpComment,
	type ClickUpFetchConfig,
	type ClickUpTask,
	type ClickUpUser,
	fetchAuthorizedTeams,
	fetchTaskComments,
	fetchTeamTasks,
} from "./clickup-source-fetch";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import { logger } from "./logger";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { getSecret } from "./secrets";
import { indexSourceArtifactStructure, purgeSourceArtifactStructure } from "./source-artifact-graph";
import { assertIngestNotDegraded, snapshotSourceIngest } from "./source-ingest-gate";
import { type SourceParticipant, indexSourceParticipants } from "./source-participant-graph";
import type { SourceProviderAdapter, SourceProviderSyncContext, SourceProviderSyncResult } from "./source-providers";
import { purgeSourceOwnedRows } from "./source-purge";

const CLICKUP_PROVIDER_KIND = "clickup";
const CLICKUP_HARNESS = "clickup";

export const clickUpSourceProvider: SourceProviderAdapter = {
	kind: "clickup",
	sync: syncClickUpSource,
	purge: (source, agentId) => purgeSourceOwnedRows({ sourceId: source.id, agentId }),
};

interface ResolvedTeam {
	readonly id: string;
	readonly name: string;
	/** Member id → member, used to recover an email the task payload left off. */
	readonly members: ReadonlyMap<string, ClickUpUser>;
}

async function syncClickUpSource(context: SourceProviderSyncContext): Promise<SourceProviderSyncResult> {
	const settings = parseClickUpSettings(context.source.providerSettings);
	if (settings.tokenRef.length === 0) throw new Error("ClickUp source has no tokenRef");

	const failures: SourceFailureState[] = [];
	const syncStartedAt = new Date().toISOString();
	const agentId = context.agentId || resolveDaemonAgentId();
	const config: ClickUpFetchConfig = { token: await resolveToken(settings.tokenRef) };
	const teams = await resolveTeams(context.source, settings, config, failures);

	let indexed = 0;
	let scanned = 0;
	let commentBudget = settings.maxCommentTasksPerSync;
	const ingestBefore = snapshotSourceIngest(agentId, context.source.id);

	for (const team of teams) {
		if (!context.shouldContinue()) break;
		const currentPath = workspacePath(team.id);
		context.onProgress?.({ scanned, total: teams.length, indexed, currentPath });
		const failuresBefore = failures.length;
		try {
			const result = await syncTeam(context, settings, config, agentId, team, commentBudget, failures);
			indexed += result.indexed;
			commentBudget -= result.commentTasksFetched;
			if (failures.length === failuresBefore) {
				purgeStaleClickUpArtifacts(context.source.id, agentId, syncStartedAt, result.seenPaths, team.id);
			}
		} catch (err) {
			failures.push(
				failureState(context.source, `ClickUp sync failed for workspace ${team.id}: ${errorMessage(err)}`, {
					teamId: team.id,
					teamName: team.name,
				}),
			);
		}
		scanned++;
		context.onProgress?.({ scanned, total: teams.length, indexed, currentPath });
	}

	// Before the failure artifacts, so a degraded sync cannot bury its own
	// evidence under rows that make the count look healthy.
	assertIngestNotDegraded(agentId, context.source.id, ingestBefore);

	for (const failure of failures) {
		indexed += writeFailureArtifact(context.source, agentId, failure);
	}
	return { indexed, scanned, total: teams.length, failures };
}

interface TeamSyncResult {
	readonly indexed: number;
	readonly commentTasksFetched: number;
	readonly seenPaths: ReadonlySet<string>;
}

async function syncTeam(
	context: SourceProviderSyncContext,
	settings: ClickUpSourceSettings,
	config: ClickUpFetchConfig,
	agentId: string,
	team: ResolvedTeam,
	commentBudget: number,
	failures: SourceFailureState[],
): Promise<TeamSyncResult> {
	const fetched = await fetchTeamTasks(config, team.id, {
		includeClosed: settings.includeClosed,
		includeSubtasks: settings.includeSubtasks,
		...(settings.since ? { since: settings.since } : {}),
		limit: settings.maxTasksPerTeam,
	});
	for (const error of fetched.errors) {
		failures.push(failureState(context.source, error.message, { teamId: team.id, retryable: error.retryable }));
	}
	if (fetched.truncated) {
		// A silent cap reads as "the workspace has this many tasks", which is the
		// exact lie the ingest gate exists to prevent elsewhere.
		logger.warn("clickup-source", "Task fetch stopped at the configured cap", {
			teamId: team.id,
			limit: settings.maxTasksPerTeam,
		});
	}

	const seenPaths = new Set<string>();
	const yielder = yieldEvery(5);
	let indexed = 0;
	let commentTasksFetched = 0;

	const known = new Set(fetched.tasks.map((task) => task.id));
	indexed += writeWorkspaceArtifact(context.source, agentId, team, seenPaths);

	for (const task of fetched.tasks) {
		if (!context.shouldContinue()) break;
		const containers = ensureContainers(context.source, agentId, team, task, seenPaths);
		indexed += containers.written;
		// A subtask hangs off its parent task when that parent came back in the same
		// page set; otherwise it hangs off its list, because a dangling parent path
		// would orphan the artifact out of the containment tree entirely.
		const container = task.parent && known.has(task.parent) ? taskPath(team.id, task.parent) : containers.containerPath;
		indexed += writeTaskArtifact(context.source, agentId, team, task, container, seenPaths);

		if (settings.includeComments && commentTasksFetched < commentBudget) {
			try {
				const comments = await fetchTaskComments(config, task.id);
				commentTasksFetched++;
				for (const comment of comments) {
					indexed += writeCommentArtifact(context.source, agentId, team, task, comment, seenPaths);
				}
			} catch (err) {
				failures.push(
					failureState(context.source, `ClickUp comment fetch failed: ${errorMessage(err)}`, {
						teamId: team.id,
						taskId: task.id,
					}),
				);
			}
		}
		await yielder();
	}

	return { indexed, commentTasksFetched, seenPaths };
}

async function resolveTeams(
	source: SignetSourceEntry,
	settings: ClickUpSourceSettings,
	config: ClickUpFetchConfig,
	failures: SourceFailureState[],
): Promise<readonly ResolvedTeam[]> {
	let authorized: readonly { id: string; name: string; members: readonly ClickUpUser[] }[] = [];
	try {
		authorized = await fetchAuthorizedTeams(config);
	} catch (err) {
		failures.push(failureState(source, `ClickUp workspace lookup failed: ${errorMessage(err)}`, { phase: "teams" }));
		return [];
	}
	const wanted = new Set(settings.teamIds);
	const selected = wanted.size > 0 ? authorized.filter((team) => wanted.has(team.id)) : authorized;
	for (const teamId of wanted) {
		if (!selected.some((team) => team.id === teamId)) {
			failures.push(
				failureState(source, `Configured ClickUp workspace is not visible to this token: ${teamId}`, { teamId }),
			);
		}
	}
	return selected.map((team) => ({
		id: team.id,
		name: team.name,
		members: new Map(team.members.map((member) => [String(member.id), member])),
	}));
}

async function resolveToken(tokenRef: string): Promise<string> {
	try {
		return await getSecret(tokenRef);
	} catch (err) {
		throw new Error(`Failed to resolve ClickUp token ref '${tokenRef}': ${errorMessage(err)}`);
	}
}

// ---------------------------------------------------------------------------
// Artifact writers
// ---------------------------------------------------------------------------

function writeWorkspaceArtifact(
	source: SignetSourceEntry,
	agentId: string,
	team: ResolvedTeam,
	seenPaths: Set<string>,
): number {
	const path = workspacePath(team.id);
	if (seenPaths.has(path)) return 0;
	const content = `# ClickUp workspace ${team.name}`;
	indexExternalMemoryArtifact({
		agentId,
		harness: CLICKUP_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `workspace:${team.id}`,
		sourcePath: path,
		sourceKind: "source_clickup_workspace",
		sourceMtimeMs: Date.now(),
		content,
		sourceMeta: { provider: CLICKUP_PROVIDER_KIND, teamId: team.id, name: team.name },
	});
	indexSourceArtifactStructure({
		agentId,
		sourceId: source.id,
		sourceKind: "source_clickup_workspace",
		sourceRoot: source.root,
		sourcePath: path,
		displayName: team.name,
		content,
	});
	seenPaths.add(path);
	return 1;
}

interface ContainerResult {
	readonly written: number;
	/** Path the task should hang off when it is not a subtask. */
	readonly containerPath: string;
}

/**
 * Materialise the space and list a task names, once each.
 *
 * The task payload already carries both, so this costs no request — it is why
 * the connector never walks `/space` and `/list` at all.
 */
function ensureContainers(
	source: SignetSourceEntry,
	agentId: string,
	team: ResolvedTeam,
	task: ClickUpTask,
	seenPaths: Set<string>,
): ContainerResult {
	let written = 0;
	let parent = workspacePath(team.id);

	if (task.space) {
		const path = spacePath(team.id, task.space.id);
		written += writeContainerArtifact(source, agentId, {
			path,
			parentPath: parent,
			sourceKind: "source_clickup_space",
			externalId: `space:${task.space.id}`,
			displayName: task.space.name,
			meta: { provider: CLICKUP_PROVIDER_KIND, teamId: team.id, spaceId: task.space.id, name: task.space.name },
			seenPaths,
		});
		parent = path;
	}
	if (task.list) {
		const path = listPath(team.id, task.list.id);
		written += writeContainerArtifact(source, agentId, {
			path,
			parentPath: parent,
			sourceKind: "source_clickup_list",
			externalId: `list:${task.list.id}`,
			displayName: task.list.name,
			meta: {
				provider: CLICKUP_PROVIDER_KIND,
				teamId: team.id,
				listId: task.list.id,
				name: task.list.name,
				...(task.folder ? { folderId: task.folder.id, folderName: task.folder.name } : {}),
			},
			seenPaths,
		});
		parent = path;
	}
	return { written, containerPath: parent };
}

interface ContainerArtifactInput {
	readonly path: string;
	readonly parentPath: string;
	readonly sourceKind: string;
	readonly externalId: string;
	readonly displayName: string;
	readonly meta: Readonly<Record<string, unknown>>;
	readonly seenPaths: Set<string>;
}

function writeContainerArtifact(source: SignetSourceEntry, agentId: string, input: ContainerArtifactInput): number {
	if (input.seenPaths.has(input.path)) return 0;
	const content = `# ${input.displayName}`;
	indexExternalMemoryArtifact({
		agentId,
		harness: CLICKUP_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: input.externalId,
		sourceParentPath: input.parentPath,
		sourcePath: input.path,
		sourceKind: input.sourceKind,
		sourceMtimeMs: Date.now(),
		content,
		sourceMeta: input.meta,
	});
	indexSourceArtifactStructure({
		agentId,
		sourceId: source.id,
		sourceKind: input.sourceKind,
		sourceRoot: source.root,
		sourceParentPath: input.parentPath,
		sourcePath: input.path,
		displayName: input.displayName,
		content,
	});
	input.seenPaths.add(input.path);
	return 1;
}

function writeTaskArtifact(
	source: SignetSourceEntry,
	agentId: string,
	team: ResolvedTeam,
	task: ClickUpTask,
	parentPath: string,
	seenPaths: Set<string>,
): number {
	const path = taskPath(team.id, task.id);
	if (seenPaths.has(path)) return 0;
	const assigneeNames = task.assignees.map((user) => displayFor(user, team)).filter((name) => name.length > 0);
	const content = [
		`# ${task.name}`,
		"",
		`Status: ${task.status}`,
		assigneeNames.length > 0 ? `Assignees: ${assigneeNames.join(", ")}` : undefined,
		task.dueDate ? `Due: ${task.dueDate}` : undefined,
		task.priority ? `Priority: ${task.priority}` : undefined,
		task.tags.length > 0 ? `Tags: ${task.tags.join(", ")}` : undefined,
		task.url ? `URL: ${task.url}` : undefined,
		"",
		task.description,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");

	indexExternalMemoryArtifact({
		agentId,
		harness: CLICKUP_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `task:${task.id}`,
		sourceParentPath: parentPath,
		sourcePath: path,
		sourceKind: "source_clickup_task",
		sourceMtimeMs: Date.parse(task.dateUpdated ?? "") || Date.now(),
		...(task.dateCreated ? { capturedAt: task.dateCreated } : {}),
		content,
		sourceMeta: {
			provider: CLICKUP_PROVIDER_KIND,
			teamId: team.id,
			taskId: task.id,
			// Consumed by `deepLinkForArtifact`'s explicit-url rule, so no ClickUp
			// branch is needed there: the API hands us the canonical link.
			url: task.url,
			status: task.status,
			parent: task.parent,
			priority: task.priority,
			tags: task.tags,
			spaceId: task.space?.id ?? null,
			listId: task.list?.id ?? null,
			folderId: task.folder?.id ?? null,
			creator: identifierFor(task.creator, team),
			assignees: task.assignees.map((user) => identifierFor(user, team)).filter((id) => id.length > 0),
			watchers: task.watchers.map((user) => identifierFor(user, team)).filter((id) => id.length > 0),
			dateCreated: task.dateCreated,
			dateUpdated: task.dateUpdated,
			dateClosed: task.dateClosed,
			dueDate: task.dueDate,
			// The description arrives with the task — there is no second request to
			// skip — so the ingest gate's "claims a body, has none" check applies.
			bodyFetched: true,
		},
	});
	const structure = indexSourceArtifactStructure({
		agentId,
		sourceId: source.id,
		sourceKind: "source_clickup_task",
		sourceRoot: source.root,
		sourceParentPath: parentPath,
		sourcePath: path,
		displayName: task.name,
		content,
	});

	writeParticipants(agentId, source, "source_clickup_task", path, structure.documentEntityId, [
		...participantsFor(task.creator, team, "authored_by", `user-asserted: creator of ClickUp task ${task.id}`),
		...task.assignees.flatMap((user) =>
			participantsFor(user, team, "addressed_to", `user-asserted: assignee of ClickUp task ${task.id}`),
		),
		...task.watchers.flatMap((user) =>
			participantsFor(user, team, "copied_on", `user-asserted: watcher of ClickUp task ${task.id}`),
		),
	]);

	seenPaths.add(path);
	return 1;
}

function writeCommentArtifact(
	source: SignetSourceEntry,
	agentId: string,
	team: ResolvedTeam,
	task: ClickUpTask,
	comment: ClickUpComment,
	seenPaths: Set<string>,
): number {
	const path = `${taskPath(team.id, task.id)}/comments/${encodeURIComponent(comment.id)}`;
	if (seenPaths.has(path)) return 0;
	const author = displayFor(comment.user, team);
	const content = [
		`# Comment on ${task.name}`,
		"",
		author ? `Author: ${author}` : undefined,
		comment.date ? `Date: ${comment.date}` : undefined,
		"",
		comment.text,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");

	indexExternalMemoryArtifact({
		agentId,
		harness: CLICKUP_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `comment:${comment.id}`,
		sourceParentPath: taskPath(team.id, task.id),
		sourcePath: path,
		sourceKind: "source_clickup_comment",
		sourceMtimeMs: Date.parse(comment.date ?? "") || Date.now(),
		...(comment.date ? { capturedAt: comment.date } : {}),
		content,
		sourceMeta: {
			provider: CLICKUP_PROVIDER_KIND,
			teamId: team.id,
			taskId: task.id,
			commentId: comment.id,
			// ClickUp has no per-comment permalink, so the task URL is the honest
			// target — it is where a human lands to read this comment.
			url: task.url,
			author: identifierFor(comment.user, team),
			resolved: comment.resolved,
			date: comment.date,
			bodyFetched: true,
		},
	});
	const structure = indexSourceArtifactStructure({
		agentId,
		sourceId: source.id,
		sourceKind: "source_clickup_comment",
		sourceRoot: source.root,
		sourceParentPath: taskPath(team.id, task.id),
		sourcePath: path,
		displayName: `Comment on ${task.name}`,
		content,
	});

	writeParticipants(agentId, source, "source_clickup_comment", path, structure.documentEntityId, [
		...participantsFor(comment.user, team, "authored_by", `user-asserted: author of ClickUp comment ${comment.id}`),
	]);

	seenPaths.add(path);
	return 1;
}

function writeParticipants(
	agentId: string,
	source: SignetSourceEntry,
	sourceKind: string,
	sourcePath: string,
	documentEntityId: string,
	participants: readonly SourceParticipant[],
): void {
	if (participants.length === 0) return;
	const result = indexSourceParticipants({
		agentId,
		sourceId: source.id,
		sourceKind,
		sourceRoot: source.root,
		sourcePath,
		documentEntityId,
		participants,
	});
	if (result.typeConflicts.length > 0) {
		logger.info("clickup-source", "Participants already present under a non-person entity type", {
			sourcePath,
			identifiers: result.typeConflicts,
		});
	}
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The one string that decides whether ClickUp joins the people graph or forks it.
 *
 * An email address is shared with the mail connector, so keying on it collapses
 * the two sources onto one entity for free. A numeric member id is shared with
 * nothing, so it gets a `clickup:` prefix and stays a distinct row until a human
 * merges it — inventing a bare-number entity would be worse than an honest
 * unlinked one.
 */
function identifierFor(user: ClickUpUser | null, team: ResolvedTeam): string {
	if (!user) return "";
	const email = user.email ?? team.members.get(String(user.id))?.email ?? null;
	if (email?.includes("@")) return email.trim().toLowerCase();
	return `clickup:${user.id}`;
}

function displayFor(user: ClickUpUser | null, team: ResolvedTeam): string {
	if (!user) return "";
	const known = team.members.get(String(user.id));
	return (user.username ?? known?.username ?? "").trim();
}

function participantsFor(
	user: ClickUpUser | null,
	team: ResolvedTeam,
	edgeType: SourceParticipant["edgeType"],
	reason: string,
): readonly SourceParticipant[] {
	const identifier = identifierFor(user, team);
	if (identifier.length === 0) return [];
	const displayName = displayFor(user, team);
	return [
		{
			identifier,
			...(displayName ? { displayName } : {}),
			edgeType,
			// Every one of these is a structural field of the task record, asserted by
			// the workspace itself. Nothing here is inferred.
			strength: 1,
			reason,
		},
	];
}

// ---------------------------------------------------------------------------
// Paths and helpers
// ---------------------------------------------------------------------------

function workspacePath(teamId: string): string {
	return `clickup://${teamId}`;
}

function spacePath(teamId: string, spaceId: string): string {
	return `clickup://${teamId}/spaces/${spaceId}`;
}

function listPath(teamId: string, listId: string): string {
	return `clickup://${teamId}/lists/${listId}`;
}

/**
 * Task paths are team-scoped but not list-scoped: ClickUp task ids are globally
 * unique and a task can be *moved* between lists, which would otherwise rewrite
 * its path and make the stale purge delete and recreate its whole history.
 */
function taskPath(teamId: string, taskId: string): string {
	return `clickup://${teamId}/tasks/${taskId}`;
}

function failureState(
	source: SignetSourceEntry,
	message: string,
	metadata?: Readonly<Record<string, unknown>>,
): SourceFailureState {
	return {
		sourceId: source.id,
		providerKind: CLICKUP_PROVIDER_KIND,
		failedAt: new Date().toISOString(),
		recoverable: true,
		message,
		metadata,
	};
}

function writeFailureArtifact(source: SignetSourceEntry, agentId: string, failure: SourceFailureState): number {
	const fingerprint = createHash("sha256")
		.update(failure.message)
		.update("\0")
		.update(JSON.stringify(failure.metadata ?? {}))
		.digest("hex")
		.slice(0, 16);
	indexExternalMemoryArtifact({
		agentId,
		harness: CLICKUP_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: `failure:${failure.failedAt}:${failure.message}`,
		sourcePath: `clickup://source/${source.id}/failures/${encodeURIComponent(failure.failedAt)}-${fingerprint}`,
		sourceKind: "source_clickup_failure",
		sourceMtimeMs: Date.parse(failure.failedAt) || Date.now(),
		capturedAt: failure.failedAt,
		content: failure.message,
		sourceMeta: failure.metadata,
	});
	return 1;
}

function purgeStaleClickUpArtifacts(
	sourceId: string,
	agentId: string,
	syncStartedAt: string,
	seenPaths: ReadonlySet<string>,
	teamId: string,
): void {
	const prefix = `${workspacePath(teamId)}/`;
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT rowid, source_path FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_path >= ?
					   AND source_path < ?
					   AND updated_at < ?
					   AND COALESCE(is_deleted, 0) = 0`,
				)
				.all(agentId, sourceId, prefix, `${prefix}￿`, syncStartedAt) as Array<{
				rowid: number;
				source_path: string;
			}>,
	);
	for (const row of rows) {
		if (seenPaths.has(row.source_path)) continue;
		purgeSourceArtifactStructure({ agentId, sourceId, sourcePath: row.source_path });
	}
	getDbAccessor().withWriteTx((db) => {
		for (const row of rows) {
			if (seenPaths.has(row.source_path)) continue;
			countChanges(
				db
					.prepare("UPDATE memory_artifacts SET is_deleted = 1, updated_at = ? WHERE rowid = ?")
					.run(syncStartedAt, row.rowid),
			);
		}
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
