import { constants, accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { enableGraphiqState, updateGraphiqActiveProject } from "@signet/core";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { getDbAccessor } from "../db-accessor";
import { getAgentsDir, resolveGraphiqBinary, runCommand } from "../graphiq";
import { ingestKnowledgeBaseRows } from "../knowledge-base-ingest";
import { indexKnowledgeBaseSource, refreshKnowledgeBaseSyncSources } from "../knowledge-base-sync";
import {
	type KnowledgeBaseKind,
	type KnowledgeBaseMapping,
	createKnowledgeBase,
	listKnowledgeBasePolicies,
	listKnowledgeBases,
	parseKnowledgeSource,
	readKnowledgeSource,
	resolveWorkspaceDefaultAgentIds,
	setKnowledgeBasePolicy,
	sourceMetadataForPath,
} from "../knowledge-bases";
import { SIGNET_GRAPHIQ_PLUGIN_ID } from "../plugins/bundled/graphiq";
import { getDefaultPluginHost } from "../plugins/index.js";
import { AGENTS_DIR, authConfig } from "./state";
import { toRecord } from "./utils";

interface ImportBody {
	readonly name?: unknown;
	readonly kind?: unknown;
	readonly path?: unknown;
	readonly content?: unknown;
	readonly filename?: unknown;
	readonly agentId?: unknown;
	readonly mapping?: unknown;
}

function stringValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function kindValue(value: unknown, fallback: KnowledgeBaseKind): KnowledgeBaseKind {
	const text = stringValue(value);
	if (
		text === "csv" ||
		text === "json" ||
		text === "sqlite" ||
		text === "postgres" ||
		text === "filesystem" ||
		text === "repo" ||
		text === "obsidian" ||
		text === "codebase"
	) {
		return text;
	}
	return fallback;
}

function mappingValue(value: unknown): KnowledgeBaseMapping | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as KnowledgeBaseMapping;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function numberValue(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function parseIndexStats(output: string): {
	readonly files?: number;
	readonly symbols?: number;
	readonly edges?: number;
} {
	const match = output.match(/Files:\s+(\d+)\s+Symbols:\s+(\d+).*?Edges:\s+(\d+)/s);
	if (!match) return {};
	return {
		files: Number.parseInt(match[1] ?? "", 10),
		symbols: Number.parseInt(match[2] ?? "", 10),
		edges: Number.parseInt(match[3] ?? "", 10),
	};
}

export function registerKnowledgeBaseRoutes(app: Hono): void {
	app.use("/api/knowledge-bases", async (c, next) => requirePermission("recall", authConfig)(c, next));
	app.use("/api/knowledge-bases/*", async (c, next) => {
		if (c.req.method === "GET") return requirePermission("recall", authConfig)(c, next);
		return requirePermission("connectors", authConfig)(c, next);
	});

	app.get("/api/knowledge-bases", (c) => {
		const items = getDbAccessor().withReadDb((db) => listKnowledgeBases(db));
		return c.json({ items });
	});

	app.get("/api/knowledge-bases/:id/policies", (c) => {
		const id = c.req.param("id");
		const items = getDbAccessor().withReadDb((db) => listKnowledgeBasePolicies(db, id));
		return c.json({ items });
	});

	app.post("/api/knowledge-bases/:id/agents/:agentId", async (c) => {
		const id = c.req.param("id");
		const agentId = c.req.param("agentId");
		const body = toRecord(await c.req.json().catch(() => ({}))) ?? {};
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			setKnowledgeBasePolicy(db, id, agentId, {
				allowed: typeof body.allowed === "boolean" ? body.allowed : undefined,
				enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
				now,
			});
		});
		return c.json({ ok: true });
	});

	app.post("/api/knowledge-bases/connect", async (c) => {
		const body = toRecord(await c.req.json().catch(() => ({}))) ?? {};
		const name = stringValue(body.name);
		if (!name) return c.json({ error: "name is required" }, 400);
		const kind = kindValue(body.kind, "sqlite");
		if (kind !== "sqlite" && kind !== "postgres") return c.json({ error: "kind must be sqlite or postgres" }, 400);
		const uri = stringValue(body.uri);
		if (!uri) return c.json({ error: "uri is required" }, 400);
		const agentId = stringValue(body.agentId) ?? resolveWorkspaceDefaultAgentIds(AGENTS_DIR)[0] ?? "default";
		const now = new Date().toISOString();
		const config = {
			...(toRecord(body.config) ?? {}),
			pollIntervalMs: numberValue(body.pollIntervalMs, numberValue(toRecord(body.config)?.pollIntervalMs, 60_000)),
		};
		const id = getDbAccessor().withWriteTx((db) =>
			createKnowledgeBase(db, {
				id: crypto.randomUUID(),
				name,
				kind,
				sourceUri: uri,
				sourceConfig: config,
				mapping: mappingValue(body.mapping),
				createdByAgentId: agentId,
				defaultAgentIds: resolveWorkspaceDefaultAgentIds(AGENTS_DIR),
				now,
			}),
		);
		await refreshKnowledgeBaseSyncSources().catch(() => 0);
		const result = await indexKnowledgeBaseSource(id).catch((err) => ({
			imported: 0,
			skipped: 0,
			embedded: 0,
			attributes: 0,
			relationships: 0,
			tombstoned: 0,
			errors: [errorMessage(err)],
		}));
		return c.json({ id, name, kind, status: "registered", ...result });
	});

	app.post("/api/knowledge-bases/import", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as ImportBody;
		const requestedPath = stringValue(body.path);
		const inlineContent = typeof body.content === "string" ? body.content : null;
		if (!requestedPath && inlineContent === null) return c.json({ error: "path or content is required" }, 400);

		let sourceUri = stringValue(body.filename) ?? "inline";
		let content = inlineContent ?? "";
		let kind: KnowledgeBaseKind = kindValue(body.kind, "json");
		let metadata: Record<string, unknown> = {};
		try {
			if (requestedPath) {
				if (!existsSync(requestedPath)) return c.json({ error: "source path does not exist" }, 400);
				const source = readKnowledgeSource(requestedPath, stringValue(body.kind) ?? undefined);
				kind = source.kind;
				content = source.content;
				sourceUri = source.sourceUri;
				metadata = sourceMetadataForPath(source.sourceUri);
			} else if (kind === "filesystem" && inlineContent === null) {
				content = readFileSync(sourceUri, "utf8");
			}
		} catch (err) {
			return c.json({ error: `failed to read source: ${errorMessage(err)}` }, 400);
		}

		const name =
			stringValue(body.name) ??
			(requestedPath ? (sourceUri.split("/").pop() ?? "knowledge-base") : "inline-knowledge-base");
		const agentId = stringValue(body.agentId) ?? resolveWorkspaceDefaultAgentIds(AGENTS_DIR)[0] ?? "default";
		const mapping = mappingValue(body.mapping);
		const now = new Date().toISOString();
		const rows = parseKnowledgeSource({ kind, content });
		if (rows.length === 0) return c.json({ error: "source contained no importable records" }, 400);

		const kbId = getDbAccessor().withWriteTx((db) =>
			createKnowledgeBase(db, {
				id: crypto.randomUUID(),
				name,
				kind,
				sourceUri,
				sourceConfig: metadata,
				mapping,
				createdByAgentId: agentId,
				defaultAgentIds: resolveWorkspaceDefaultAgentIds(AGENTS_DIR),
				now,
			}),
		);

		const result = await ingestKnowledgeBaseRows({
			knowledgeBaseId: kbId,
			name,
			kind,
			sourceUri,
			rows,
			mapping,
			agentId,
			actor: "knowledge_base_import",
			now,
		});

		return c.json({ id: kbId, name, kind, ...result });
	});

	app.post("/api/knowledge-bases/sources", async (c) => {
		const body = toRecord(await c.req.json().catch(() => ({}))) ?? {};
		const name = stringValue(body.name);
		const sourceUri = stringValue(body.path) ?? stringValue(body.uri);
		if (!name) return c.json({ error: "name is required" }, 400);
		if (!sourceUri) return c.json({ error: "path or uri is required" }, 400);
		const kind = kindValue(body.kind, "filesystem");
		if (kind !== "filesystem" && kind !== "repo" && kind !== "obsidian") {
			return c.json({ error: "kind must be filesystem, repo, or obsidian" }, 400);
		}
		if (!existsSync(sourceUri)) return c.json({ error: "source path does not exist" }, 400);
		const agentId = stringValue(body.agentId) ?? resolveWorkspaceDefaultAgentIds(AGENTS_DIR)[0] ?? "default";
		const now = new Date().toISOString();
		const config = {
			watch: body.watch !== false,
			pollIntervalMs: numberValue(body.pollIntervalMs, 60_000),
			include: Array.isArray(body.include) ? body.include : undefined,
			exclude: Array.isArray(body.exclude) ? body.exclude : undefined,
		};
		const id = getDbAccessor().withWriteTx((db) =>
			createKnowledgeBase(db, {
				id: crypto.randomUUID(),
				name,
				kind,
				sourceUri: resolve(sourceUri),
				sourceConfig: config,
				mapping: mappingValue(body.mapping),
				createdByAgentId: agentId,
				defaultAgentIds: resolveWorkspaceDefaultAgentIds(AGENTS_DIR),
				now,
			}),
		);
		await refreshKnowledgeBaseSyncSources().catch(() => 0);
		const result = await indexKnowledgeBaseSource(id).catch((err) => ({
			imported: 0,
			skipped: 0,
			embedded: 0,
			attributes: 0,
			relationships: 0,
			tombstoned: 0,
			errors: [errorMessage(err)],
		}));
		return c.json({ id, name, kind, status: "registered", ...result });
	});

	app.post("/api/knowledge-bases/:id/sync", async (c) => {
		const id = c.req.param("id");
		const result = await indexKnowledgeBaseSource(id);
		return c.json({ id, ...result });
	});

	app.post("/api/knowledge-bases/codebase", async (c) => {
		const body = toRecord(await c.req.json().catch(() => ({}))) ?? {};
		const name = stringValue(body.name);
		const path = stringValue(body.path);
		if (!path) return c.json({ error: "path is required" }, 400);
		const resolved = resolve(path);
		if (!existsSync(resolved)) return c.json({ error: `Project path does not exist: ${resolved}` }, 400);
		const stat = statSync(resolved);
		if (!stat.isDirectory()) return c.json({ error: `Project path must be a directory: ${resolved}` }, 400);
		try {
			accessSync(resolved, constants.R_OK | constants.X_OK);
		} catch {
			return c.json({ error: `Project path must be readable: ${resolved}` }, 400);
		}
		const binary = resolveGraphiqBinary();
		if (!binary) return c.json({ error: "GraphIQ binary not found. Run `signet graphiq install` first." }, 400);
		const dbPath = `${resolved}/.graphiq/graphiq.db`;
		const graph = await runCommand(binary, ["index", resolved, "--db", dbPath], 300_000);
		if (graph.code !== 0) {
			return c.json({ error: graph.stderr.trim() || graph.stdout.trim() || "graphiq index failed" }, 500);
		}
		const stats = parseIndexStats(graph.stdout);
		const agentsDir = getAgentsDir();
		enableGraphiqState(agentsDir, { installSource: "existing" });
		updateGraphiqActiveProject(agentsDir, { projectPath: resolved, ...stats });
		getDefaultPluginHost().setEnabled(SIGNET_GRAPHIQ_PLUGIN_ID, true);
		const agentId = stringValue(body.agentId) ?? resolveWorkspaceDefaultAgentIds(AGENTS_DIR)[0] ?? "default";
		const now = new Date().toISOString();
		const kbName = name ?? resolved.split("/").filter(Boolean).pop() ?? "codebase";
		const id = getDbAccessor().withWriteTx((db) =>
			createKnowledgeBase(db, {
				id: crypto.randomUUID(),
				name: kbName,
				kind: "codebase",
				sourceUri: resolved,
				sourceConfig: { graphiqDbPath: dbPath, graphiq: stats },
				mapping: mappingValue(body.mapping),
				createdByAgentId: agentId,
				defaultAgentIds: resolveWorkspaceDefaultAgentIds(AGENTS_DIR),
				now,
			}),
		);
		return c.json({ id, name: kbName, kind: "codebase", project: resolved, stats });
	});
}
