import chalk from "chalk";
import type { Command } from "commander";

interface KnowledgeBaseDeps {
	readonly ensureDaemonForSecrets: () => Promise<boolean>;
	readonly secretApiCall: (
		method: string,
		path: string,
		body?: unknown,
		timeoutMs?: number,
	) => Promise<{ ok: boolean; data: unknown }>;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function errorMessage(data: unknown, fallback: string): string {
	const error = asRecord(data).error;
	return typeof error === "string" ? error : fallback;
}

async function api(deps: KnowledgeBaseDeps, method: string, path: string, body?: unknown): Promise<unknown> {
	const result = await deps.secretApiCall(method, path, body, 120_000);
	if (!result.ok || typeof asRecord(result.data).error === "string") {
		console.error(chalk.red(`  ${errorMessage(result.data, "Knowledge base request failed")}`));
		process.exit(1);
	}
	return result.data;
}

function printList(data: unknown): void {
	const items = (asRecord(data).items as Array<Record<string, unknown>> | undefined) ?? [];
	if (items.length === 0) {
		console.log(chalk.dim("  No knowledge bases found"));
		return;
	}
	console.log(chalk.bold("\n  Knowledge Bases\n"));
	for (const item of items) {
		console.log(`  ${chalk.cyan(String(item.name ?? item.id ?? "unknown"))} ${chalk.dim(String(item.kind ?? ""))}`);
		const parts = [item.id, item.status, item.sourceUri ?? item.source_uri].filter(Boolean).map(String);
		if (parts.length > 0) console.log(chalk.dim(`    ${parts.join(" · ")}`));
	}
	console.log();
}

function printPolicies(data: unknown): void {
	const items = (asRecord(data).items as Array<Record<string, unknown>> | undefined) ?? [];
	if (items.length === 0) {
		console.log(chalk.dim("  No agent policies found"));
		return;
	}
	console.log(chalk.bold("\n  Knowledge Base Agent Policies\n"));
	for (const item of items) {
		const allowed = item.allowed ? chalk.green("allowed") : chalk.red("denied");
		const enabled = item.enabled ? chalk.green("enabled") : chalk.yellow("disabled");
		console.log(`  ${chalk.cyan(String(item.agentId ?? item.agent_id ?? "unknown"))}  ${allowed}  ${enabled}`);
	}
	console.log();
}

export function registerKnowledgeBaseCommands(program: Command, deps: KnowledgeBaseDeps): void {
	const kb = program.command("kb").alias("knowledge-base").description("Manage scoped knowledge bases");

	kb.command("list")
		.description("List knowledge bases")
		.option("--json", "Output JSON")
		.action(async (options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const data = await api(deps, "GET", "/api/knowledge-bases");
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else printList(data);
		});

	kb.command("import")
		.description("Import CSV, JSON, or a text file as a scoped knowledge base")
		.argument("<path>", "Source file path")
		.option("--name <name>", "Knowledge base name")
		.option("--kind <kind>", "Source kind: csv, json, filesystem")
		.option("--agent <agent>", "Agent that owns the imported memory rows")
		.option("--mapping <json>", "Inline mapping JSON")
		.option("--json", "Output JSON")
		.action(async (path: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			let mapping: unknown;
			if (options.mapping) {
				try {
					mapping = JSON.parse(options.mapping);
				} catch {
					console.error(chalk.red("  --mapping must be valid JSON"));
					process.exit(1);
				}
			}
			const data = await api(deps, "POST", "/api/knowledge-bases/import", {
				path,
				name: options.name,
				kind: options.kind,
				agentId: options.agent,
				mapping,
			});
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else {
				const r = asRecord(data);
				console.log(chalk.green(`  ✓ Imported ${r.imported ?? 0} records into ${r.name ?? r.id}`));
				console.log(
					chalk.dim(`    skipped ${r.skipped ?? 0} · embedded ${r.embedded ?? 0} · attributes ${r.attributes ?? 0}`),
				);
			}
		});

	kb.command("connect")
		.description("Register and poll a read-only database knowledge source")
		.argument("<kind>", "sqlite or postgres")
		.option("--name <name>", "Knowledge base name")
		.option("--uri <uri>", "Database URI or file path")
		.option("--table <table>", "Table or view to poll")
		.option("--primary-key <field>", "Stable primary key field")
		.option("--query <sql>", "Read-only query override")
		.option("--config <json>", "Connection config JSON")
		.option("--mapping <json>", "Inline mapping JSON")
		.option("--json", "Output JSON")
		.action(async (kind: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			let config = asRecord({});
			let mapping: unknown;
			if (options.config) {
				try {
					config = asRecord(JSON.parse(options.config));
				} catch {
					console.error(chalk.red("  --config must be valid JSON"));
					process.exit(1);
				}
			}
			if (options.mapping) {
				try {
					mapping = JSON.parse(options.mapping);
				} catch {
					console.error(chalk.red("  --mapping must be valid JSON"));
					process.exit(1);
				}
			}
			const data = await api(deps, "POST", "/api/knowledge-bases/connect", {
				kind,
				name: options.name ?? options.uri ?? kind,
				uri: options.uri,
				config: { ...config, table: options.table, primaryKey: options.primaryKey, query: options.query },
				mapping,
			});
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else
				console.log(chalk.green(`  ✓ Registered ${kind} knowledge base ${asRecord(data).name ?? asRecord(data).id}`));
		});

	kb.command("source")
		.description("Register a watched filesystem, repo, or Obsidian knowledge source")
		.argument("<path>", "Source path")
		.option("--name <name>", "Knowledge base name")
		.option("--kind <kind>", "filesystem, repo, or obsidian", "filesystem")
		.option("--mapping <json>", "Inline mapping JSON")
		.option("--json", "Output JSON")
		.action(async (path: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			let mapping: unknown;
			if (options.mapping) {
				try {
					mapping = JSON.parse(options.mapping);
				} catch {
					console.error(chalk.red("  --mapping must be valid JSON"));
					process.exit(1);
				}
			}
			const data = await api(deps, "POST", "/api/knowledge-bases/sources", {
				path,
				name: options.name,
				kind: options.kind,
				mapping,
			});
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else console.log(chalk.green(`  ✓ Registered watched source ${asRecord(data).name ?? asRecord(data).id}`));
		});

	kb.command("codebase")
		.description("Register a codebase knowledge source through GraphIQ")
		.argument("<path>", "Project path")
		.option("--name <name>", "Knowledge base name")
		.option("--json", "Output JSON")
		.action(async (path: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const data = await api(deps, "POST", "/api/knowledge-bases/codebase", { path, name: options.name });
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else console.log(chalk.green(`  ✓ Registered GraphIQ codebase ${asRecord(data).name ?? asRecord(data).id}`));
		});

	kb.command("sync")
		.description("Sync one knowledge base now")
		.argument("<id>", "Knowledge base id")
		.option("--json", "Output JSON")
		.action(async (id: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const data = await api(deps, "POST", `/api/knowledge-bases/${encodeURIComponent(id)}/sync`);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else console.log(chalk.green(`  ✓ Synced ${id}`));
		});

	kb.command("policies")
		.description("Show per-agent access policy for a knowledge base")
		.argument("<id>", "Knowledge base id")
		.option("--json", "Output JSON")
		.action(async (id: string, options) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const data = await api(deps, "GET", `/api/knowledge-bases/${encodeURIComponent(id)}/policies`);
			if (options.json) console.log(JSON.stringify(data, null, 2));
			else printPolicies(data);
		});

	function policyCommand(name: "allow" | "deny" | "enable" | "disable", body: Record<string, boolean>): void {
		kb.command(name)
			.description(`${name} an agent for a knowledge base`)
			.argument("<id>", "Knowledge base id")
			.argument("<agent>", "Agent id")
			.action(async (id: string, agent: string) => {
				if (!(await deps.ensureDaemonForSecrets())) return;
				await api(
					deps,
					"POST",
					`/api/knowledge-bases/${encodeURIComponent(id)}/agents/${encodeURIComponent(agent)}`,
					body,
				);
				console.log(chalk.green(`  ✓ ${name} ${agent} for ${id}`));
			});
	}
	policyCommand("allow", { allowed: true, enabled: true });
	policyCommand("deny", { allowed: false });
	policyCommand("enable", { enabled: true });
	policyCommand("disable", { enabled: false });
}
