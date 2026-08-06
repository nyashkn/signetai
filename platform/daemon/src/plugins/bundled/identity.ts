import type { PluginManifestV1, PluginSurfaceDeclarationsV1 } from "../types.js";

export const SIGNET_IDENTITY_PLUGIN_ID = "signet.identity";

/**
 * The surface split mirrors the write policy the identity work settled on:
 * additive and reversible acts apply, destructive ones only propose. So
 * `identity:link` and `identity:unlink` exist as separate capabilities from
 * `identity:merge:propose`, and there is deliberately no `identity:merge`.
 */
const IDENTITY_CAPABILITIES = [
	"identity:read",
	"identity:link",
	"identity:unlink",
	"identity:principal:read",
	"identity:principal:declare",
	"identity:merge:propose",
	"identity:merge:decide",
	"knowledge:trail",
	"mcp:tool",
	"cli:command",
	"dashboard:panel",
] as const;

const surfaces: PluginSurfaceDeclarationsV1 = {
	daemonRoutes: [
		{
			method: "GET",
			path: "/api/ontology/entities/:id/aliases",
			summary: "List the handles an entity answers to",
			requiredCapabilities: ["identity:read"],
		},
		{
			method: "POST",
			path: "/api/ontology/entities/:id/aliases",
			summary: "Record a handle against an entity — applies immediately, audited",
			requiredCapabilities: ["identity:link"],
		},
		{
			method: "DELETE",
			path: "/api/ontology/entities/:id/aliases/:aliasId",
			summary: "Archive a handle; the row survives so the link stays reconstructable",
			requiredCapabilities: ["identity:unlink"],
		},
		{
			method: "GET",
			path: "/api/knowledge/principal",
			summary: "The agent's operator and their context-scoped handles",
			requiredCapabilities: ["identity:principal:read"],
		},
		{
			method: "POST",
			path: "/api/knowledge/principal",
			summary: "Declare the operator's identities; user-asserted, applies at 1.0",
			requiredCapabilities: ["identity:principal:declare"],
		},
		{
			method: "GET",
			path: "/api/knowledge/touched",
			summary: "Everything one identity is attached to, deep-linked",
			requiredCapabilities: ["knowledge:trail"],
		},
		{
			method: "GET",
			path: "/api/knowledge/who-touched",
			summary: "The people and organizations attached to a thing",
			requiredCapabilities: ["knowledge:trail"],
		},
		{
			method: "GET",
			path: "/api/knowledge/timeline",
			summary: "One identity's activity across every connected source",
			requiredCapabilities: ["knowledge:trail"],
		},
		{
			method: "GET",
			path: "/api/knowledge/trail",
			summary: "Ordered provenance chains out of a person or thing",
			requiredCapabilities: ["knowledge:trail"],
		},
		{
			method: "POST",
			path: "/api/ontology/proposals/repair/duplicates",
			summary: "Scan for duplicate identities and queue merge proposals",
			requiredCapabilities: ["identity:merge:propose"],
		},
		{
			method: "POST",
			path: "/api/ontology/proposals/repair/merge-plan",
			summary: "Queue a hand-made merge for review",
			requiredCapabilities: ["identity:merge:propose"],
		},
		{
			method: "POST",
			path: "/api/ontology/proposals/:id/apply",
			summary: "Apply a pending proposal — the only path a merge can take",
			requiredCapabilities: ["identity:merge:decide"],
		},
		{
			method: "POST",
			path: "/api/ontology/proposals/:id/reject",
			summary: "Reject a pending proposal; rejection is sticky",
			requiredCapabilities: ["identity:merge:decide"],
		},
	],
	mcpTools: [
		{
			name: "identity_handles",
			title: "Identity Handles",
			summary: "Every handle an entity answers to, with the source that asserted each",
			requiredCapabilities: ["mcp:tool", "identity:read"],
		},
		{
			name: "identity_link",
			title: "Link Identity",
			summary: "Record a handle — additive and reversible, so it applies",
			requiredCapabilities: ["mcp:tool", "identity:link"],
		},
		{
			name: "identity_unlink",
			title: "Unlink Identity",
			summary: "Archive a handle",
			requiredCapabilities: ["mcp:tool", "identity:unlink"],
		},
		{
			name: "ontology_propose",
			title: "Propose Ontology Change",
			summary: "Queue a graph change for operator review; the only route to a merge",
			requiredCapabilities: ["mcp:tool", "identity:merge:propose"],
		},
		{
			name: "knowledge_what_touched",
			title: "What Touched",
			summary: "Everything one identity is attached to",
			requiredCapabilities: ["mcp:tool", "knowledge:trail"],
		},
		{
			name: "knowledge_who_touched",
			title: "Who Touched",
			summary: "The people and organizations attached to a thing",
			requiredCapabilities: ["mcp:tool", "knowledge:trail"],
		},
		{
			name: "knowledge_timeline",
			title: "Cross-source Timeline",
			summary: "One identity's activity across every connected source",
			requiredCapabilities: ["mcp:tool", "knowledge:trail"],
		},
		{
			name: "knowledge_trail",
			title: "Trail",
			summary: "Ordered provenance chains out of a person or thing",
			requiredCapabilities: ["mcp:tool", "knowledge:trail"],
		},
	],
	cliCommands: [
		{
			path: ["principal", "show"],
			summary: "Print the declared operator identity",
			requiredCapabilities: ["cli:command", "identity:principal:read"],
		},
		{
			path: ["principal", "set"],
			summary: "Declare the operator's identities, seeded from configured mail accounts",
			requiredCapabilities: ["cli:command", "identity:principal:declare"],
		},
	],
	sdkClients: [],
	connectorCapabilities: [],
	promptContributions: [],
	dashboardPanels: [
		{
			id: "signet.identity.review-queue",
			title: "Review Queue",
			summary: "Pending ontology proposals with evidence, apply/reject, and a duplicate scan",
			requiredCapabilities: ["dashboard:panel", "identity:merge:decide", "identity:merge:propose"],
		},
		{
			id: "signet.identity.entity-card",
			title: "Identity",
			summary: "An entity's handles and what it touched, grouped by source",
			requiredCapabilities: ["dashboard:panel", "identity:read", "identity:link", "identity:unlink"],
		},
		{
			id: "signet.identity.daily-brief",
			title: "Identity in the Daily Brief",
			summary: "Pending identity decisions surfaced where the operator already looks",
			requiredCapabilities: ["dashboard:panel", "identity:merge:decide"],
		},
	],
};

export const signetIdentityManifest: PluginManifestV1 = {
	id: SIGNET_IDENTITY_PLUGIN_ID,
	name: "Signet Identity",
	version: "1.0.0",
	publisher: "signetai",
	description:
		"Resolves people and organizations across sources: handles, principal declaration, duplicate detection, " +
		"merge review, and the trail queries that read them.",
	runtime: {
		language: "typescript",
		kind: "bundled-module",
		entry: "@signet/daemon/plugins/bundled/identity",
	},
	compatibility: {
		signet: ">=0.99.0 <1.0.0",
		pluginApi: "1.x",
	},
	trustTier: "core",
	capabilities: IDENTITY_CAPABILITIES,
	surfaces,
	marketplace: {
		categories: ["knowledge", "identity"],
		license: "Apache-2.0",
		repository: "https://github.com/Signet-AI/signetai",
		homepage: "https://signetai.sh",
		checksum: null,
		signature: null,
	},
	docs: {
		homepage: "https://signetai.sh/docs/identity",
		capabilities: {
			"identity:read": { summary: "Read the handles an entity answers to" },
			"identity:link": {
				summary:
					"Record a handle against an entity Applies immediately with an audit row. An alias is additive and reversible, so it follows the apply-first rule rather than the proposal queue.",
			},
			"identity:unlink": {
				summary:
					"Archive a handle Archiving, not deleting — the row survives so the link stays reconstructable. Unlinking a merge-derived alias orphans the name, because its entity is already gone.",
			},
			"identity:principal:read": { summary: "Read the agent's operator and their context-scoped handles" },
			"identity:principal:declare": {
				summary:
					"Declare who the operator is User-asserted, so handles enter at confidence 1.0. Existing entities for a declared handle are left alone and returned as merge candidates.",
			},
			"identity:merge:propose": {
				summary:
					"Queue a merge for review There is deliberately no `identity:merge`. A merge hard-deletes the source entity; migration 107 records lineage but the graph edit itself is not undone automatically.",
			},
			"identity:merge:decide": { summary: "Apply or reject a pending proposal as the operator" },
			"knowledge:trail": { summary: "Query what an identity touched, who touched a thing, and provenance chains" },
			"mcp:tool": { summary: "Expose the identity tools over MCP" },
			"cli:command": { summary: "Expose `signet principal`" },
			"dashboard:panel": { summary: "Render the review queue, entity card and brief section" },
		},
	},
};
