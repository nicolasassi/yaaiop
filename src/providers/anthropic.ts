import Anthropic from "@anthropic-ai/sdk";
import type {
	ChatMessage,
	ChatPart,
	ChatProvider,
	CompletionRequest,
	CompletionResult,
	ProviderInfo,
	StopReason,
	StreamCallbacks,
	StructuredRequest,
	ToolDefinition,
	ToolResultPart,
} from "./types";
import { partsToText } from "./types";

/**
 * Models whose policy declines are rerouted server-side (`fallbacks: "default"`).
 * Kept to models whose default fallback route is documented, since naming one
 * without a route is a 400 rather than a no-op.
 */
const SERVER_FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5"]);

export const ANTHROPIC_PROVIDER: ProviderInfo = {
	id: "anthropic",
	name: "Anthropic (Claude)",
	defaultModel: "claude-opus-5",
	utilityModel: "claude-haiku-4-5",
	apiKeyUrl: "https://console.anthropic.com/settings/keys",
	apiKeyPlaceholder: "sk-ant-...",
	models: [
		{
			id: "claude-fable-5-1",
			label: "Claude Fable 5.1 (most capable, premium)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "claude-opus-5",
			label: "Claude Opus 5 (recommended)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "claude-sonnet-5",
			label: "Claude Sonnet 5 (balanced)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "claude-opus-4-8",
			label: "Claude Opus 4.8",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "claude-haiku-4-5",
			label: "Claude Haiku 4.5 (fastest, cheapest)",
			supportsReasoning: false,
			supportsImages: true,
			supportsDocuments: true,
		},
	],
};

export class AnthropicProvider implements ChatProvider {
	readonly info = ANTHROPIC_PROVIDER;
	private client: Anthropic | null = null;

	constructor(private getApiKey: () => string) {}

	isConfigured(): boolean {
		return this.getApiKey().length > 0;
	}

	reset(): void {
		this.client = null;
	}

	private sdk(): Anthropic {
		if (this.client) return this.client;

		const apiKey = this.getApiKey();
		if (!apiKey) throw new Error("No API key set. Add one in the plugin settings.");

		this.client = new Anthropic({
			apiKey,
			// Obsidian is a webview on every platform, so the SDK's Node paths are
			// unavailable. This flag is what makes the SDK send
			// `anthropic-dangerous-direct-browser-access`, which is how Anthropic
			// permits browser-origin calls — the alternative would be proxying
			// through a server, which breaks the no-backend requirement.
			//
			// The usual warning behind this flag is about shipping a key to
			// untrusted end users. Here the "browser" is the user's own Obsidian
			// and the key is their own, entered locally.
			dangerouslyAllowBrowser: true,
			maxRetries: 2,
		});
		return this.client;
	}

	async streamCompletion(
		request: CompletionRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<CompletionResult> {
		const model = this.info.models.find((m) => m.id === request.model);

		// The beta endpoint is used for every model so there is one code path; it
		// only differs from the stable one when a beta is actually named below.
		const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
			model: request.model,
			max_tokens: request.maxTokens,
			system: request.system,
			messages: toAnthropicMessages(request.messages),
			tools: toAnthropicTools(request.tools),
			// Auto-caches the last cacheable block, so each turn re-reads the
			// system prompt and prior history from cache instead of paying full
			// price. Tool results are large; this matters.
			cache_control: { type: "ephemeral" },
			stream: true,
		};

		// Older models reject `thinking` and `output_config` outright, so they are
		// only sent for models that advertise reasoning support.
		if (model?.supportsReasoning) {
			params.thinking = {
				type: "adaptive",
				// Without this, thinking blocks stream with empty text and the UI
				// shows a long pause before the first token of the answer.
				display: request.includeReasoning ? "summarized" : "omitted",
			};
			params.output_config = { effort: request.effort };
		}

		// A policy decline is re-run server-side on a model Anthropic picks for that
		// refusal category, inside the same stream, instead of ending the turn.
		// Rate limits and outages are never rerouted — only declines.
		if (SERVER_FALLBACK_MODELS.has(request.model)) {
			params.betas = ["server-side-fallback-2026-07-01"];
			params.fallbacks = "default";
		}

		const stream = this.sdk().beta.messages.stream(params, { signal });

		for await (const event of stream) {
			if (event.type !== "content_block_delta") continue;
			if (event.delta.type === "text_delta") {
				callbacks.onText(event.delta.text);
			} else if (event.delta.type === "thinking_delta" && request.includeReasoning) {
				callbacks.onThinking(event.delta.thinking);
			}
		}

		const message = await stream.finalMessage();
		return {
			parts: fromAnthropicContent(message.content),
			stopReason: toStopReason(message.stop_reason),
			refusalReason: message.stop_details?.category ?? undefined,
		};
	}

	/**
	 * Structured outputs constrain the reply itself to JSON matching the schema,
	 * so it parses without a tool round-trip. Forced tool use would do the same
	 * job but is rejected by some models (Claude Fable 5.1), which this works on.
	 * No `thinking` here — utility models are picked for being cheap, and the
	 * call is not on the user's critical path.
	 */
	async structuredCompletion(request: StructuredRequest, signal: AbortSignal): Promise<unknown> {
		const response = await this.sdk().messages.create(
			{
				model: request.model,
				max_tokens: request.maxTokens,
				system: request.system,
				messages: [{ role: "user", content: request.prompt }],
				output_config: {
					format: {
						type: "json_schema",
						schema: {
							type: "object",
							properties: request.schema.properties,
							required: request.schema.required ?? [],
							additionalProperties: false,
						},
					},
				},
			},
			{ signal },
		);

		// A refused or truncated body is a normal outcome, not an error worth
		// surfacing — the caller treats a null result as "nothing to report".
		if (response.stop_reason !== "end_turn") return null;
		try {
			return JSON.parse(partsToText(fromAnthropicContent(response.content))) as unknown;
		} catch {
			return null;
		}
	}

	async testConnection(model: string): Promise<void> {
		const response = await this.sdk().messages.create({
			model,
			max_tokens: 16,
			messages: [{ role: "user", content: "Reply with the single word: ok" }],
		});
		if (response.stop_reason === "refusal") {
			throw new Error("The model declined the test request.");
		}
	}
}

/**
 * Tool results may carry vault attachments. The Messages API accepts image and
 * document blocks inside a tool_result, so an image or PDF the model asked for
 * travels back through the normal tool path rather than needing a side channel.
 */
function toToolResultContent(
	part: ToolResultPart,
): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam> {
	if (!part.media || part.media.length === 0) return part.content;

	const blocks: Array<
		Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam
	> = [{ type: "text", text: part.content }];

	for (const item of part.media) {
		if (item.kind === "image") {
			blocks.push({
				type: "image",
				source: {
					type: "base64",
					media_type: item.mediaType as Anthropic.Base64ImageSource["media_type"],
					data: item.data,
				},
			});
		} else {
			blocks.push({
				type: "document",
				title: item.name,
				source: { type: "base64", media_type: "application/pdf", data: item.data },
			});
		}
	}
	return blocks;
}

function toStopReason(reason: string | null): StopReason {
	switch (reason) {
		case "tool_use":
			return "tool_calls";
		case "max_tokens":
			return "max_tokens";
		case "refusal":
			return "refused";
		case "model_context_window_exceeded":
			return "context_full";
		default:
			return "end";
	}
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: {
			type: "object" as const,
			properties: tool.parameters.properties,
			required: tool.parameters.required,
		},
	}));
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
	return messages.map((message) => {
		if (message.role === "user") {
			const content: Anthropic.ContentBlockParam[] = [];
			for (const part of message.parts) {
				if (part.type === "text") {
					content.push({ type: "text", text: part.text });
				} else if (part.type === "tool_result") {
					content.push({
						type: "tool_result",
						tool_use_id: part.toolCallId,
						content: toToolResultContent(part),
						is_error: part.isError,
					});
				}
			}
			return { role: "user", content };
		}

		const content: Anthropic.ContentBlockParam[] = [];
		// Reasoning must lead the assistant turn and be replayed exactly as the
		// API produced it — signature included — so the stored original is used
		// and anything without one is dropped rather than reconstructed.
		// Blocks saved by another provider are shaped differently and are skipped.
		for (const part of message.parts) {
			if (part.type === "thinking" && isThinkingBlock(part.raw)) {
				content.push(part.raw);
			}
		}
		for (const part of message.parts) {
			if (part.type === "text" && part.text) {
				content.push({ type: "text", text: part.text });
			} else if (part.type === "tool_call") {
				content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
			}
		}
		return { role: "assistant", content };
	});
}

/**
 * Saved chats are replayed from disk and can predate a provider switch, so the
 * opaque block on a thinking part is checked before being handed back to the API
 * rather than trusted to be ours.
 */
function isThinkingBlock(
	raw: unknown,
): raw is Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam {
	if (typeof raw !== "object" || raw === null) return false;
	const type = (raw as { type?: unknown }).type;
	return type === "thinking" || type === "redacted_thinking";
}

function fromAnthropicContent(
	content: Array<Anthropic.ContentBlock | Anthropic.Beta.BetaContentBlock>,
): ChatPart[] {
	// After a mid-output fallback, reasoning and tool calls produced before the
	// last switch point belong to a model that declined: they cannot be replayed
	// and the calls must not run. Text before it is kept — the fallback model
	// continued from it. The `fallback` block itself is only an audit marker.
	let lastFallback = -1;
	content.forEach((block, i) => {
		if (block.type === "fallback") lastFallback = i;
	});

	const parts: ChatPart[] = [];
	for (const [i, block] of content.entries()) {
		if (i < lastFallback && block.type !== "text") continue;
		switch (block.type) {
			case "text":
				parts.push({ type: "text", text: block.text });
				break;
			case "thinking":
				parts.push({ type: "thinking", text: block.thinking, raw: block });
				break;
			case "redacted_thinking":
				// No readable text, but it still has to be replayed verbatim.
				parts.push({ type: "thinking", text: "", raw: block });
				break;
			case "tool_use":
				parts.push({
					type: "tool_call",
					id: block.id,
					name: block.name,
					input: (block.input ?? {}) as Record<string, unknown>,
				});
				break;
			default:
				break;
		}
	}
	return parts;
}
