/**
 * ClickUp REST v2 driver for the ClickUp source connector.
 *
 * The cost model that shapes this file: **one request returns the whole
 * workspace.** `GET /team/{id}/task` pages every task the token can see, and
 * each task payload already inlines its `space`, `folder` and `list`, so the
 * containment tree is reconstructed from the task rows themselves rather than
 * crawled space -> folder -> list. That turns an N+1 walk into one paginated
 * call, the same shape as the single `imap fetch 1:*` that made the email
 * connector affordable.
 *
 * Comments are the exception — one request per task — so the provider budgets
 * them exactly as it budgets email body fetches.
 */

import { logger } from "./logger";

const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
/** ClickUp's documented page size for the filtered-team-tasks endpoint. */
const TASKS_PAGE_SIZE = 100;
/** A runaway `page` loop against a huge workspace is worse than a truncated sync. */
const MAX_TASK_PAGES = 200;

export interface ClickUpFetchConfig {
	readonly token: string;
}

/**
 * A ClickUp member.
 *
 * `email` is the field that matters: it is the same string the email connector
 * keys people on, so an assignee and a correspondent collapse onto one entity
 * without any identity inference. Guests and some SSO members expose no email,
 * which is why it stays optional and the provider falls back to the member id.
 */
export interface ClickUpUser {
	readonly id: number | string;
	readonly username?: string | null;
	readonly email?: string | null;
	readonly initials?: string | null;
}

export interface ClickUpTeam {
	readonly id: string;
	readonly name: string;
	readonly members: readonly ClickUpUser[];
}

export interface ClickUpContainer {
	readonly id: string;
	readonly name: string;
}

export interface ClickUpTask {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly status: string;
	readonly url: string;
	readonly creator: ClickUpUser | null;
	readonly assignees: readonly ClickUpUser[];
	readonly watchers: readonly ClickUpUser[];
	readonly tags: readonly string[];
	/** Task id of the parent when this is a subtask. */
	readonly parent: string | null;
	readonly priority: string | null;
	readonly dateCreated: string | null;
	readonly dateUpdated: string | null;
	readonly dateClosed: string | null;
	readonly dueDate: string | null;
	readonly space: ClickUpContainer | null;
	readonly folder: ClickUpContainer | null;
	readonly list: ClickUpContainer | null;
}

export interface ClickUpComment {
	readonly id: string;
	readonly text: string;
	readonly user: ClickUpUser | null;
	readonly resolved: boolean;
	readonly date: string | null;
}

export interface ClickUpFetchError {
	readonly message: string;
	readonly retryable: boolean;
}

export interface ClickUpTaskFetchResult {
	readonly tasks: readonly ClickUpTask[];
	readonly errors: readonly ClickUpFetchError[];
	/** The page cap or the task budget stopped the walk before the workspace ran out. */
	readonly truncated: boolean;
}

export interface ClickUpRequestInput {
	/** Path below `/api/v2`, e.g. `/team/123/task`. */
	readonly path: string;
	readonly query?: Readonly<Record<string, string>>;
	readonly token: string;
}

export type ClickUpRunner = (input: ClickUpRequestInput) => Promise<unknown>;

let clickUpRunnerOverride: ClickUpRunner | null = null;

/** Test seam — swap the API for a fixture without a token or a network. */
export function setClickUpRunnerForTests(runner: ClickUpRunner | null): void {
	clickUpRunnerOverride = runner;
}

function runner(): ClickUpRunner {
	return clickUpRunnerOverride ?? requestClickUp;
}

/**
 * A personal token goes in `Authorization` verbatim — no `Bearer` prefix, which
 * OAuth access tokens do use. Sending `Bearer pk_...` answers 401 with a message
 * that says nothing about the prefix, so this is worth stating once here.
 */
async function requestClickUp(input: ClickUpRequestInput): Promise<unknown> {
	const query = new URLSearchParams(input.query ?? {}).toString();
	const url = `${CLICKUP_API_BASE}${input.path}${query ? `?${query}` : ""}`;
	const headers: Record<string, string> = {
		Authorization: input.token.startsWith("pk_") ? input.token : `Bearer ${input.token}`,
		Accept: "application/json",
	};

	let lastError: Error | null = null;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
			clearTimeout(timeout);
			timeout = null;
			// ClickUp caps at 100 requests/minute per token and reports the window
			// end in seconds. Sleeping through it beats burning retries on 429s.
			if (response.status === 429) {
				const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0") * 1000;
				const waitMs = reset > Date.now() ? Math.min(reset - Date.now() + 1000, 60_000) : RETRY_BASE_DELAY_MS;
				await new Promise((resolve) => setTimeout(resolve, waitMs));
				continue;
			}
			if (response.status >= 500) {
				lastError = new Error(`ClickUp API ${response.status}`);
				await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
				continue;
			}
			if (!response.ok) throw new Error(`ClickUp API ${response.status}: ${await response.text()}`);
			return await response.json();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRIES - 1) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	throw lastError ?? new Error("ClickUp API request failed after retries");
}

// ---------------------------------------------------------------------------
// Payload shaping
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** ClickUp dates are epoch milliseconds as strings; store ISO so every consumer agrees. */
function isoDate(value: unknown): string | null {
	const raw = typeof value === "number" ? value : Number(typeof value === "string" ? value : Number.NaN);
	if (!Number.isFinite(raw) || raw <= 0) return null;
	return new Date(raw).toISOString();
}

function toUser(value: unknown): ClickUpUser | null {
	const row = record(value);
	if (!row) return null;
	const id = row.id;
	if (typeof id !== "number" && typeof id !== "string") return null;
	return {
		id,
		username: optionalText(row.username),
		email: optionalText(row.email),
		initials: optionalText(row.initials),
	};
}

function toUsers(value: unknown): readonly ClickUpUser[] {
	if (!Array.isArray(value)) return [];
	return value.map(toUser).filter((user): user is ClickUpUser => user !== null);
}

function toContainer(value: unknown): ClickUpContainer | null {
	const row = record(value);
	if (!row) return null;
	const id = optionalText(row.id) ?? (typeof row.id === "number" ? String(row.id) : null);
	if (!id) return null;
	return { id, name: text(row.name) || id };
}

function toTask(value: unknown): ClickUpTask | null {
	const row = record(value);
	if (!row) return null;
	const id = optionalText(row.id);
	if (!id) return null;
	const status = record(row.status);
	const priority = record(row.priority);
	const parent = record(row.parent);
	return {
		id,
		name: text(row.name) || `Task ${id}`,
		// `markdown_description` is the round-trippable form; `description` is the
		// plain-text rendering and `text_content` the legacy one. Prefer markdown so
		// the stored artifact keeps its structure for FTS and for a human reading it.
		description: text(row.markdown_description) || text(row.description) || text(row.text_content),
		status: text(status?.status) || "unknown",
		url: text(row.url),
		creator: toUser(row.creator),
		assignees: toUsers(row.assignees),
		watchers: toUsers(row.watchers),
		tags: Array.isArray(row.tags)
			? row.tags.map((tag) => text(record(tag)?.name)).filter((name) => name.length > 0)
			: [],
		parent: optionalText(row.parent) ?? optionalText(parent?.id),
		priority: optionalText(priority?.priority),
		dateCreated: isoDate(row.date_created),
		dateUpdated: isoDate(row.date_updated),
		dateClosed: isoDate(row.date_closed),
		dueDate: isoDate(row.due_date),
		space: toContainer(row.space),
		folder: toContainer(row.folder),
		list: toContainer(row.list),
	};
}

function toComment(value: unknown): ClickUpComment | null {
	const row = record(value);
	if (!row) return null;
	const id = optionalText(row.id) ?? (typeof row.id === "number" ? String(row.id) : null);
	if (!id) return null;
	// `comment_text` is the flattened string; `comment` is the rich block array,
	// used only when the flat form is missing.
	const flat = text(row.comment_text);
	const blocks = Array.isArray(row.comment)
		? row.comment
				.map((block) => text(record(block)?.text))
				.filter((chunk) => chunk.length > 0)
				.join("")
		: "";
	return {
		id,
		text: flat || blocks,
		user: toUser(row.user),
		resolved: row.resolved === true,
		date: isoDate(row.date),
	};
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function fetchAuthorizedTeams(config: ClickUpFetchConfig): Promise<readonly ClickUpTeam[]> {
	const body = record(await runner()({ path: "/team", token: config.token }));
	const teams = Array.isArray(body?.teams) ? body.teams : [];
	return teams
		.map((entry): ClickUpTeam | null => {
			const row = record(entry);
			const id = optionalText(row?.id) ?? (typeof row?.id === "number" ? String(row.id) : null);
			if (!id) return null;
			// Members arrive wrapped as `{ user: {...} }` on `/team`, bare elsewhere.
			const members = Array.isArray(row?.members)
				? row.members
						.map((member) => toUser(record(member)?.user ?? member))
						.filter((user): user is ClickUpUser => user !== null)
				: [];
			return { id, name: text(row?.name) || id, members };
		})
		.filter((team): team is ClickUpTeam => team !== null);
}

export interface FetchTeamTasksOptions {
	readonly includeClosed: boolean;
	readonly includeSubtasks: boolean;
	/** ISO date; forwarded as ClickUp's `date_updated_gt` so the server does the filtering. */
	readonly since?: string;
	readonly limit: number;
}

export async function fetchTeamTasks(
	config: ClickUpFetchConfig,
	teamId: string,
	options: FetchTeamTasksOptions,
): Promise<ClickUpTaskFetchResult> {
	const tasks: ClickUpTask[] = [];
	const errors: ClickUpFetchError[] = [];
	const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
	let truncated = false;

	for (let page = 0; page < MAX_TASK_PAGES; page++) {
		if (tasks.length >= options.limit) {
			truncated = true;
			break;
		}
		const query: Record<string, string> = {
			page: String(page),
			subtasks: String(options.includeSubtasks),
			include_closed: String(options.includeClosed),
		};
		if (Number.isFinite(sinceMs)) query.date_updated_gt = String(sinceMs);

		let body: Record<string, unknown> | null;
		try {
			body = record(await runner()({ path: `/team/${teamId}/task`, query, token: config.token }));
		} catch (err) {
			errors.push({ message: `ClickUp task fetch failed: ${errorMessage(err)}`, retryable: true });
			break;
		}
		const page_tasks = Array.isArray(body?.tasks) ? body.tasks : [];
		for (const entry of page_tasks) {
			const task = toTask(entry);
			if (task) tasks.push(task);
		}
		// `last_page` is authoritative when present; a short page is the fallback
		// signal, and an empty one always ends the walk.
		if (body?.last_page === true || page_tasks.length === 0 || page_tasks.length < TASKS_PAGE_SIZE) break;
		if (page === MAX_TASK_PAGES - 1) {
			truncated = true;
			logger.warn("clickup-source", "Task pagination hit the page cap", { teamId, pages: MAX_TASK_PAGES });
		}
	}

	return { tasks: tasks.slice(0, options.limit), errors, truncated: truncated || tasks.length > options.limit };
}

export async function fetchTaskComments(
	config: ClickUpFetchConfig,
	taskId: string,
): Promise<readonly ClickUpComment[]> {
	const body = record(await runner()({ path: `/task/${taskId}/comment`, token: config.token }));
	const comments = Array.isArray(body?.comments) ? body.comments : [];
	return comments.map(toComment).filter((comment): comment is ClickUpComment => comment !== null);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
