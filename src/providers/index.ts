import type { ChatProvider, ProviderInfo } from "./types";
import { ANTHROPIC_PROVIDER, AnthropicProvider } from "./anthropic";

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
];

export const DEFAULT_PROVIDER_ID = ANTHROPIC_PROVIDER.id;

export function providerRegistration(id: string): ProviderRegistration {
	return PROVIDERS.find((p) => p.info.id === id) ?? PROVIDERS[0];
}

export function providerInfo(id: string): ProviderInfo {
	return providerRegistration(id).info;
}
