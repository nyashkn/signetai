/** Temporary ACPX MCP configuration for one bounded Dreaming pass. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DreamingAcpxMcpConfig {
	readonly path: string;
	dispose(): void;
}

function resolveMcpEntrypoint(): string {
	const here = fileURLToPath(import.meta.url);
	const suffix = extname(here) === ".ts" ? ".ts" : ".js";
	const entrypoint = join(dirname(dirname(here)), `mcp-stdio${suffix}`);
	if (!existsSync(entrypoint)) throw new Error(`Signet Dreaming MCP entrypoint is unavailable: ${entrypoint}`);
	return entrypoint;
}

/**
 * ACPX loads `mcpServers` only from this ephemeral config. It receives one
 * constrained Signet server, whose schemas never accept an agent id. The
 * JSON is process configuration (not application state) and is removed as
 * soon as the bounded agent turn exits.
 */
export function createDreamingAcpxMcpConfig(params: {
	readonly agentId: string;
	readonly passId: string;
	readonly daemonUrl: string;
	readonly authorizationToken?: string;
}): DreamingAcpxMcpConfig {
	const dir = mkdtempSync(join(tmpdir(), "signet-dreaming-mcp-"));
	const path = join(dir, "mcp.json");
	const env = [
		{ name: "SIGNET_DREAMING_AGENT_ID", value: params.agentId },
		{ name: "SIGNET_DREAMING_PASS_ID", value: params.passId },
		{ name: "SIGNET_DAEMON_URL", value: params.daemonUrl },
		...(params.authorizationToken ? [{ name: "SIGNET_TOKEN", value: params.authorizationToken }] : []),
	];
	writeFileSync(
		path,
		JSON.stringify({
			mcpServers: [
				{
					name: "signet_dreaming",
					command: process.execPath,
					args: [resolveMcpEntrypoint()],
					env,
				},
			],
		}),
		{ mode: 0o600 },
	);
	return {
		path,
		dispose() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
