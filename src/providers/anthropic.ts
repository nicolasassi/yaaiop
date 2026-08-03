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

export const ANTHROPIC_PROVIDER: ProviderInfo = {
	id: "anthropic",
	name: "Anthropic (Claude)",
	defaultModel: "claude-opus-5",
	utilityModel: "claude-haiku-4-5",
	apiKeyUrl: "https://console.anthropic.com/settings/keys",
	apiKeyPlaceholder: "sk-ant-...",
	models: [
		{
			id: "claude-opus-5",
			label: "Claude Opus 5 (most capable)",
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

		const params: Anthropic.MessageCreateParamsStreaming = {
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

		const stream = this.sdk().messages.stream(params, { signal });

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
	 * Forced tool use is how the Messages API guarantees a shape: the model has
	 * exactly one tool and no choice but to call it, so the arguments it builds
	 * are the answer. No `thinking` here — utility models are picked for being
	 * cheap, and the call is not on the user's critical path.
	 */
	async structuredCompletion(request: StructuredRequest, signal: AbortSignal): Promise<unknown> {
		const response = await this.sdk().messages.create(
			{
				model: request.model,
				max_tokens: request.maxTokens,
				system: request.system,
				messages: [{ role: "user", content: request.prompt }],
				tools: [
					{
						name: "respond",
						description: "Return the result. This is the only way to answer.",
						input_schema: {
							type: "object" as const,
							properties: request.schema.properties,
							required: request.schema.required,
						},
					},
				],
				tool_choice: { type: "tool", name: "respond" },
			},
			{ signal },
		);

		const call = response.content.find((block) => block.type === "tool_use");
		return call ? call.input : null;
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
		for (const part of message.parts) {
			if (part.type === "thinking" && part.raw) {
				content.push(part.raw as Anthropic.ContentBlockParam);
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

function fromAnthropicContent(content: Anthropic.ContentBlock[]): ChatPart[] {
	const parts: ChatPart[] = [];
	for (const block of content) {
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
