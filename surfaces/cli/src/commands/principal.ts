import type { Command } from "commander";
import type { DaemonApiCall } from "../lib/daemon.js";

export interface RegisterPrincipalCommandsDeps {
	readonly secretApiCall: DaemonApiCall;
}

interface PrincipalHandle {
	readonly identifier: string;
	readonly kind: string | null;
	readonly organization: string | null;
}

interface PrincipalPayload {
	readonly entityId: string;
	readonly displayName: string;
	readonly handles: readonly PrincipalHandle[];
	readonly aliasesWritten?: number;
	readonly organizationsCreated?: number;
	readonly mergeCandidates?: readonly string[];
}

function errorText(data: unknown): string {
	if (typeof data === "object" && data !== null && "error" in data) {
		return String((data as { error?: unknown }).error);
	}
	return "daemon request failed";
}

function print(principal: PrincipalPayload): void {
	console.log(`${principal.displayName}  (${principal.entityId})`);
	for (const handle of principal.handles) {
		const kind = handle.kind ?? "unknown";
		const org = handle.organization ? `  org: ${handle.organization}` : "";
		console.log(`  ${handle.identifier}  [${kind}]${org}`);
	}
	if (principal.handles.length === 0) console.log("  (no handles declared)");
}

export function registerPrincipalCommands(program: Command, deps: RegisterPrincipalCommandsDeps): void {
	const principal = program
		.command("principal")
		.description("Declare who operates this agent, and under which organizations");

	principal
		.command("show")
		.description("Show the declared operator and every handle linked to them")
		.option("--agent <agentId>", "Agent to read", "default")
		.action(async (options: { agent: string }) => {
			const result = await deps.secretApiCall(
				"GET",
				`/api/knowledge/principal?agent_id=${encodeURIComponent(options.agent)}`,
				undefined,
				15_000,
			);
			if (!result?.ok) {
				console.error(errorText(result?.data));
				process.exitCode = 1;
				return;
			}
			const payload = (result.data as { principal?: PrincipalPayload | null }).principal;
			if (!payload) {
				console.log("No principal declared. Run `signet principal set --name <you>` to seed from your mail accounts.");
				return;
			}
			print(payload);
		});

	principal
		.command("set")
		.description("Declare the operator; handles default to the addresses of your configured mail accounts")
		.requiredOption("--name <displayName>", "Canonical display name for the operator")
		.option("--agent <agentId>", "Agent to write", "default")
		.option(
			"--email <address>",
			"Declare an address explicitly, optionally org-scoped as address@domain=Org. Repeatable.",
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.action(async (options: { name: string; agent: string; email: string[] }) => {
			// With no --email flags the daemon reads the configured mail accounts —
			// the SASL username is the address the server itself authenticates, so
			// there is nothing to confirm.
			const identities = options.email.map((entry) => {
				const [identifier, organization] = entry.split("=");
				return {
					identifier: (identifier ?? "").trim(),
					kind: "email",
					...(organization && organization.trim().length > 0 ? { organization: organization.trim() } : {}),
				};
			});

			const result = await deps.secretApiCall(
				"POST",
				"/api/knowledge/principal",
				{
					agentId: options.agent,
					displayName: options.name,
					...(identities.length > 0 ? { identities } : {}),
				},
				30_000,
			);
			if (!result?.ok) {
				console.error(errorText(result?.data));
				process.exitCode = 1;
				return;
			}

			const payload = (result.data as { principal: PrincipalPayload }).principal;
			print(payload);
			if (payload.aliasesWritten !== undefined) {
				console.log(
					`\n${payload.aliasesWritten} alias(es) written, ${payload.organizationsCreated ?? 0} org(s) created.`,
				);
			}
			if (payload.mergeCandidates && payload.mergeCandidates.length > 0) {
				// Not actioned here: collapsing two entities deletes a row, so it goes
				// through the proposal queue where it is auditable and reversible.
				console.log(
					`${payload.mergeCandidates.length} existing entit(ies) already hold one of these handles and are duplicates of you.`,
				);
				console.log(
					"Lookups already resolve to the principal via the aliases; merging them is a separate review step.",
				);
			}
		});
}
