/**
 * Provider-neutral types.
 *
 * Nothing in this file may import a vendor SDK. The chat engine, the UI, and the
 * persistence layer all speak these types; each provider adapter translates them
 * to and from its own wire format. Adding a provider should mean writing one
 * adapter, not touching the engine.
 */

export type ChatRole = "user" | "assistant";

export interface TextPart {
	type: "text";
	text: string;
}

export interface ThinkingPart {
	type: "thinking";
	/** Human-readable reasoning, possibly empty if the provider hides it. */
	text: string;
	/**
	 * The provider's original block, kept verbatim.
	 *
	 * Some providers (Anthropic among them) require reasoning to be echoed back
	 * byte-identical — including an opaque signature — for a conversation to
	 * continue. Reconstructing it from `text` would fail, so adapters stash the
	 * original here and replay it untouched. Treat as opaque.
	 */
	raw?: unknown;
}

export interface ToolCallPart {
	type: "tool_call";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

/**
 * Binary content handed to the model — a vault image or PDF.
 * `data` is base64 with no `data:` prefix.
 */
export interface MediaAttachment {
	kind: "image" | "document";
	mediaType: string;
	data: string;
	/** Vault path, used as a title/label so the model can cite it. */
	name: string;
}

export interface ToolResultPart {
	type: "tool_result";
	toolCallId: string;
	content: string;
	isError: boolean;
	/**
	 * Attachments returned alongside the text. Only populated when the active
	 * model can actually consume them; adapters embed them in whatever way their
	 * wire format allows.
	 */
	media?: MediaAttachment[];
}

export type ChatPart = TextPart | ThinkingPart | ToolCallPart | ToolResultPart;

export interface ChatMessage {
	role: ChatRole;
	parts: ChatPart[];
}

/** JSON Schema for a tool's arguments. Every provider we target accepts this. */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

/**
 * How hard the model should think before answering. Providers that have no
 * equivalent ignore it rather than erroring.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ModelInfo {
	id: string;
	label: string;
	/** Whether this model exposes reasoning and accepts an effort level. */
	supportsReasoning: boolean;
	/** Vision: can accept raster images as input. */
	supportsImages: boolean;
	/** Can accept PDFs as native documents rather than extracted text. */
	supportsDocuments: boolean;
}

/** What the currently selected model can be sent, used to gate attachments. */
export interface MediaCapabilities {
	images: boolean;
	documents: boolean;
}

export interface ProviderInfo {
	id: string;
	name: string;
	models: ModelInfo[];
	defaultModel: string;
	/**
	 * The cheapest model that can follow a short instruction reliably.
	 *
	 * Used for background housekeeping the user did not ask for and should not
	 * pay chat prices for — memory extraction today. Never used to answer.
	 */
	utilityModel: string;
	/** Where the user gets a key, shown in settings. */
	apiKeyUrl: string;
	apiKeyPlaceholder: string;
}

export interface CompletionRequest {
	model: string;
	system: string;
	messages: ChatMessage[];
	tools: ToolDefinition[];
	maxTokens: number;
	effort: ReasoningEffort;
	/** When false, adapters should ask the provider not to return reasoning text. */
	includeReasoning: boolean;
}

/**
 * A one-shot request whose answer must be an object matching `schema`, rather
 * than prose. Used for background work the UI parses instead of displays.
 */
export interface StructuredRequest {
	model: string;
	system: string;
	prompt: string;
	maxTokens: number;
	/** JSON Schema for the object the model must return. */
	schema: ToolDefinition["parameters"];
}

export interface StreamCallbacks {
	onText(delta: string): void;
	onThinking(delta: string): void;
}

export type StopReason = "end" | "tool_calls" | "max_tokens" | "refused";

export interface CompletionResult {
	/** Assistant output: text, reasoning, and any tool calls it wants run. */
	parts: ChatPart[];
	stopReason: StopReason;
	/** Set when stopReason is "refused", if the provider explains why. */
	refusalReason?: string;
}

/**
 * A chat backend. Implementations own their SDK, auth, and wire format, and
 * must not leak vendor types past this boundary.
 */
export interface ChatProvider {
	readonly info: ProviderInfo;
	/** True when a usable credential is present. */
	isConfigured(): boolean;
	/** Invalidate any cached client, e.g. after the key changes. */
	reset(): void;
	streamCompletion(
		request: CompletionRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<CompletionResult>;
	/**
	 * One-shot call returning an object shaped like `request.schema`. Adapters
	 * use whatever their API offers (forced tool use, JSON mode); the caller
	 * gets parsed JSON and must still treat its contents as untrusted.
	 */
	structuredCompletion(request: StructuredRequest, signal: AbortSignal): Promise<unknown>;
	/** Cheapest possible round-trip, to validate credentials from settings. */
	testConnection(model: string): Promise<void>;
}

export function modelInfo(provider: ProviderInfo, modelId: string): ModelInfo {
	return provider.models.find((m) => m.id === modelId) ?? provider.models[0];
}

/** Convenience for the common case of pulling plain text out of a turn. */
export function partsToText(parts: ChatPart[]): string {
	return parts
		.filter((p): p is TextPart => p.type === "text")
		.map((p) => p.text)
		.join("\n");
}
