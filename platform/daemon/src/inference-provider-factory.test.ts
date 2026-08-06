import { describe, expect, test } from "bun:test";
import { parseRoutingConfig } from "@signet/core";
import { createRoutingProvider, resolveThinkingLevel } from "./inference-provider-factory";

function codexConfig(model = "gpt-5.4") {
	const parsed = parseRoutingConfig({
		inference: {
			accounts: {
				codex: { kind: "subscription_session", providerFamily: "openai-codex" },
			},
			targets: {
				codex: {
					executor: "openai-codex",
					account: "codex",
					models: { default: { model } },
				},
			},
		},
	});
	if (!parsed.ok) throw new Error(parsed.error.message);
	return parsed.value;
}

describe("inference provider factory", () => {
	test("constructs native pi-ai OAuth providers from catalog model metadata", async () => {
		const provider = await createRoutingProvider({
			config: codexConfig(),
			targetId: "codex",
			modelId: "default",
			async resolveCredential() {
				return {
					apiKey: "oauth-access",
					oauthCredentials: { refresh: "oauth-refresh", access: "oauth-access", expires: Date.now() + 60_000 },
				};
			},
		});

		expect(provider.name).toBe("openai-codex:gpt-5.4");
		expect(await provider.available()).toBe(true);
	});

	test("fails clearly when a dynamic provider model is absent from pi-ai", async () => {
		await expect(
			createRoutingProvider({
				config: codexConfig("not-a-real-model"),
				targetId: "codex",
				modelId: "default",
				async resolveCredential() {
					return { apiKey: "oauth-access" };
				},
			}),
		).rejects.toThrow('Unknown pi-ai model "not-a-real-model" for provider "openai-codex"');
	});
});

describe("resolveThinkingLevel", () => {
	// `reasoning: enabled: false` used to resolve to undefined, which means "send
	// no reasoning field" rather than "reason less". A model that thinks by
	// default kept thinking: measured on deepseek/deepseek-v4-flash-0731, 995 of
	// 1024 completion tokens went to reasoning, finish_reason "length", null
	// content — billed, and the extraction had nothing to parse.
	test("an explicit disable asks for the least thinking, not for silence", () => {
		expect(resolveThinkingLevel(false, "medium")).toBe("minimal");
	});

	test("an explicit enable still turns thinking on", () => {
		expect(resolveThinkingLevel(true, "medium")).toBe("medium");
	});

	// Unset is not the same as disabled: every parsed model defaults to depth
	// "medium", so treating absence as an instruction would flip a costly default
	// on for every routed call.
	test("an unset block leaves the provider default alone", () => {
		expect(resolveThinkingLevel(undefined, "medium")).toBeUndefined();
	});

	test("a deliberately high depth still wins when no block is present", () => {
		expect(resolveThinkingLevel(undefined, "high")).toBe("high");
	});
});
