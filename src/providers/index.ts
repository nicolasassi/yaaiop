import type { ChatProvider, ProviderInfo } from "./types";
import { ANTHROPIC_PROVIDER, AnthropicProvider } from "./anthropic";
import { OPENAI_PROVIDER, OpenAIProvider } from "./openai";
import { GOOGLE_PROVIDER, GoogleProvider } from "./google";
import { OPENROUTER_PROVIDER, OpenRouterProvider } from "./openrouter";

export * from "./types";

/**
 * The provider registry.
 *
 * To add a backend: implement ChatProvider in ./<name>.ts, then add one entry
 * here. Settings, the model picker, and per-provider key storage all read from
 * this list — nothing else needs to change.
 */
export interface ProviderRegistration {
	info: ProviderInfo;
	create(getApiKey: () => string): ChatProvider;
}

export const PROVIDERS: ProviderRegistration[] = [
	{
		info: ANTHROPIC_PROVIDER,
		create: (getApiKey) => new AnthropicProvider(getApiKey),
	},
	{
		info: OPENAI_PROVIDER,
		create: (getApiKey) => new OpenAIProvider(getApiKey),
	},
	{
		info: GOOGLE_PROVIDER,
		create: (getApiKey) => new GoogleProvider(getApiKey),
	},
	{
		info: OPENROUTER_PROVIDER,
		create: (getApiKey) => new OpenRouterProvider(getApiKey),
	},
];

export const DEFAULT_PROVIDER_ID = ANTHROPIC_PROVIDER.id;

export function providerRegistration(id: string): ProviderRegistration {
	return PROVIDERS.find((p) => p.info.id === id) ?? PROVIDERS[0];
}

export function providerInfo(id: string): ProviderInfo {
	return providerRegistration(id).info;
}
