import { type Api, type Model, type OAuthCredentials, getModels, getProviders } from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { PipelineClaudeCodeConfig, RoutingAccountConfig, RoutingConfig } from "@signet/core";
import { type PiExecutorKind, createPiModelProvider } from "./pipeline/pi-provider";
import type { AcpxHooksMode, StreamCapableLlmProvider } from "./pipeline/provider";
import { createAcpxProvider } from "./pipeline/provider";

export interface CreateRoutingProviderOptions {
	readonly config: RoutingConfig;
	readonly targetId: string;
	readonly modelId: string;
	readonly acpxHooks?: AcpxHooksMode;
	readonly claudeCode?: PipelineClaudeCodeConfig;
	resolveCredential(account: RoutingAccountConfig | undefined): Promise<ResolvedInferenceCredential | undefined>;
}

export interface ResolvedInferenceCredential {
	readonly apiKey: string;
	readonly oauthCredentials?: OAuthCredentials;
}

/**
 * Executors that have been folded into the Pi + ACPX backends (#947).
 * Encountering one means the install's agent.yaml was not migrated; the daemon
 * fails with a structured error rather than silently degrading.
 */
const FOLDED_EXECUTORS = new Set(["claude-code", "codex", "opencode", "command"]);

const CUSTOM_PI_EXECUTORS = new Set(["anthropic", "openrouter", "ollama", "llama-cpp", "openai-compatible"]);

function catalogModel(
	providerFamily: string,
	modelId: string,
	credential: ResolvedInferenceCredential | undefined,
): Model<Api> | undefined {
	if (!(getProviders() as readonly string[]).includes(providerFamily)) return undefined;
	let models = (getModels as (provider: string) => Model<Api>[])(providerFamily);
	const oauthProvider = getOAuthProvider(providerFamily);
	if (oauthProvider?.modifyModels && credential?.oauthCredentials) {
		models = oauthProvider.modifyModels(models, credential.oauthCredentials);
	}
	return models.find((candidate) => candidate.id === modelId);
}

/**
 * Map routing intent onto a pi-ai ThinkingLevel (forwarded per-call as
 * `options.reasoning`).
 *
 * `model.reasoning` (RoutingReasoningDepth) defaults to "medium" for every
 * parsed model, so it cannot alone signal "enable thinking" without turning a
 * costly default on for every routed call. Only explicit signals count.
 *
 * The case that used to be silently lost is `enabled: false`. It returned
 * `undefined`, which means "send no reasoning field" — not "reason less". A
 * model that thinks by default keeps thinking, and on a small completion budget
 * it spends the whole budget thinking and returns null content: measured on
 * `deepseek/deepseek-v4-flash-0731`, 995 of 1024 completion tokens went to
 * reasoning, `finish_reason: "length"`, no body, and the call was still billed.
 * "off" now means the least thinking the transport can ask for — measured at 27
 * reasoning tokens against 682 for the same prompt with no reasoning field.
 *
 * It is not a true zero. OpenRouter honours `reasoning: {enabled: false}` with
 * exactly 0 reasoning tokens, but pi-ai's openrouter thinking format only ever
 * emits `reasoning: {effort}`, so that payload cannot be expressed from here.
 * Sending a real disable needs a change in pi-ai or an escape hatch for raw
 * provider options.
 */
export function resolveThinkingLevel(
	openRouterReasoningEnabled: boolean | undefined,
	modelDepth: string | undefined,
): "minimal" | "medium" | "high" | undefined {
	if (openRouterReasoningEnabled === true) return "medium";
	if (openRouterReasoningEnabled === false) return "minimal";
	return modelDepth === "high" ? "high" : undefined;
}

export async function createRoutingProvider(opts: CreateRoutingProviderOptions): Promise<StreamCapableLlmProvider> {
	const target = opts.config.targets[opts.targetId];
	const model = target?.models[opts.modelId];
	if (!target || !model) {
		throw new Error(`Unknown routing target ${opts.targetId}/${opts.modelId}`);
	}

	if (target.executor === "acpx") {
		if (!target.acpx) throw new Error(`Missing ACPX config for target ${opts.targetId}`);
		return createAcpxProvider({
			...target.acpx,
			...(opts.acpxHooks ? { hooks: opts.acpxHooks } : {}),
			model: model.model,
		});
	}

	if (FOLDED_EXECUTORS.has(target.executor)) {
		throw new Error(
			`Routing executor "${target.executor}" has been folded into the Pi + ACPX backends (#947). Reconfigure target "${opts.targetId}" to use one of: anthropic, openrouter, ollama, llama-cpp, openai-compatible, acpx. For claude-code/codex/opencode use 'executor: acpx' with an 'acpx: { agent: <name> }' block; see docs/UPGRADING.md. Restart the daemon to re-run the automatic one-time config migration.`,
		);
	}

	const account = target.account ? opts.config.accounts[target.account] : undefined;
	const providerFamily = account?.providerFamily ?? target.executor;
	if (!CUSTOM_PI_EXECUTORS.has(target.executor) && !(getProviders() as readonly string[]).includes(providerFamily)) {
		throw new Error(`Unsupported routing executor "${target.executor}" for target ${opts.targetId}`);
	}

	const credential = await opts.resolveCredential(account);
	const piModel = CUSTOM_PI_EXECUTORS.has(target.executor)
		? undefined
		: catalogModel(providerFamily, model.model, credential);
	if (!piModel && !CUSTOM_PI_EXECUTORS.has(target.executor)) {
		throw new Error(`Unknown pi-ai model "${model.model}" for provider "${providerFamily}"`);
	}

	return createPiModelProvider({
		executor: target.executor as PiExecutorKind,
		providerFamily,
		model: model.model,
		piModel,
		skipAvailabilityProbe: piModel !== undefined,
		baseUrl: target.endpoint,
		apiKey: credential?.apiKey,
		reasoning: resolveThinkingLevel(target.openrouter?.reasoning?.enabled, model.reasoning),
		contextWindow: model.contextWindow,
		name: `${target.executor}:${model.model}`,
		defaultTimeoutMs: 60_000,
	});
}
