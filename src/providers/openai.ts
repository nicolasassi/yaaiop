import OpenAI from "openai";
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

export const OPENAI_PROVIDER: ProviderInfo = {
	id: "openai",
	name: "OpenAI (GPT)",
	defaultModel: "gpt-5.6-sol",
	utilityModel: "gpt-5.6-luna",
	apiKeyUrl: "https://platform.openai.com/api-keys",
	apiKeyPlaceholder: "sk-...",
	models: [
		{
			id: "gpt-5.6-sol",
			label: "GPT-5.6 Sol (most capable)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "gpt-5.6-terra",
			label: "GPT-5.6 Terra (balanced)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "gpt-5.6-luna",
			label: "GPT-5.6 Luna (fastest, cheapest)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
	],
};

export class OpenAIProvider implements ChatProvider {
	readonly info = OPENAI_PROVIDER;
	private client: OpenAI | null = null;
	/**
	 * Set once a request has been rejected for asking for reasoning summaries,
	 * which OpenAI gates behind organisation verification. Sticky for the session
	 * so the fallback costs one failed request, not one per message.
	 */
	private summariesUnavailable = false;

	constructor(private getApiKey: () => string) {}

	isConfigured(): boolean {
		return this.getApiKey().length > 0;
	}

	reset(): void {
		this.client = null;
		this.summariesUnavailable = false;
	}

	private sdk(): OpenAI {
		if (this.client) return this.client;

		const apiKey = this.getApiKey();
		if (!apiKey) throw new Error("No API key set. Add one in the plugin settings.");

		this.client = new OpenAI({
			apiKey,
			// Same reasoning as the Anthropic adapter: Obsidian is a webview on every
			// platform, so the SDK's Node paths are unavailable and it refuses to run
			// without this flag. api.openai.com answers browser-origin requests
			// (`access-control-allow-origin: *`), so no proxy is needed.
			//
			// The warning behind the flag is about shipping a key to untrusted end
			// users. Here the "browser" is the user's own Obsidian and the key is
			// their own, entered locally.
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
		const wantsSummary = request.includeReasoning && !this.summariesUnavailable;

		const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
			model: request.model,
			instructions: request.system,
			input: toOpenAIInput(request.messages),
			tools: toOpenAITools(request.tools),
			max_output_tokens: request.maxTokens,
			// Nothing is kept on OpenAI's servers: the transcript lives in the vault
			// and is replayed in full each turn. That is also what makes
			// `encrypted_content` below necessary — without storage, an encrypted
			// copy of the reasoning is the only way to carry it to the next turn.
			store: false,
			stream: true,
		};

		if (model?.supportsReasoning) {
			params.reasoning = {
				effort: request.effort,
				// Reasoning is replayed for every turn of the conversation, not just
				// the current one, so multi-step tool loops keep their train of thought.
				context: "all_turns",
				summary: wantsSummary ? "auto" : null,
			};
			params.include = ["reasoning.encrypted_content"];
		}

		try {
			return await this.runStream(params, request, callbacks, signal);
		} catch (err) {
			// Reasoning summaries need a verified organisation. Rather than failing
			// the message, drop the summary and answer without visible reasoning.
			if (wantsSummary && isVerificationError(err) && params.reasoning) {
				this.summariesUnavailable = true;
				params.reasoning = { ...params.reasoning, summary: null };
				return await this.runStream(params, request, callbacks, signal);
			}
			throw err;
		}
	}

	private async runStream(
		params: OpenAI.Responses.ResponseCreateParamsStreaming,
		request: CompletionRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<CompletionResult> {
		const stream = this.sdk().responses.stream(params, { signal });

		// A reasoning item can hold several summary parts. They arrive as separate
		// streams of deltas with no separator of their own, so one is added here or
		// the parts run together into a single wall of text.
		let summaryIndex = 0;

		for await (const event of stream) {
			switch (event.type) {
				case "response.output_text.delta":
					callbacks.onText(event.delta);
					break;
				case "response.reasoning_summary_part.added":
					if (request.includeReasoning && event.summary_index > summaryIndex) {
						summaryIndex = event.summary_index;
						callbacks.onThinking("\n\n");
					}
					break;
				case "response.reasoning_summary_text.delta":
				// Models that expose reasoning verbatim rather than as a summary
				// stream it under a different event; both land in the same panel.
				case "response.reasoning_text.delta":
					if (request.includeReasoning) callbacks.onThinking(event.delta);
					break;
				default:
					break;
			}
		}

		const response = await stream.finalResponse();
		const parts = fromOpenAIOutput(response.output);
		const refusal = findRefusal(response.output);
		const stopReason = toStopReason(response, parts, refusal);

		return {
			// Tool calls are only worth keeping when they are actually going to be
			// run. A call left over from a truncated or refused response would sit in
			// the transcript with no matching output, which the API rejects on the
			// next turn.
			parts: stopReason === "tool_calls" ? parts : parts.filter((p) => p.type !== "tool_call"),
			stopReason,
			refusalReason: refusal ?? undefined,
		};
	}

	/**
	 * Structured Outputs is how the Responses API guarantees a shape: the model is
	 * constrained to emit JSON matching the schema, so the reply parses without
	 * needing a tool round-trip. Effort is pinned low — utility models are picked
	 * for being cheap, and reasoning tokens come out of the same budget as the
	 * answer, so a thoughtful one would spend the ceiling and return nothing.
	 */
	async structuredCompletion(request: StructuredRequest, signal: AbortSignal): Promise<unknown> {
		const response = await this.sdk().responses.create(
			{
				model: request.model,
				instructions: request.system,
				input: request.prompt,
				max_output_tokens: request.maxTokens,
				store: false,
				reasoning: { effort: "low" },
				text: {
					format: {
						type: "json_schema",
						name: "respond",
						schema: {
							type: "object",
							properties: request.schema.properties,
							required: request.schema.required ?? [],
							additionalProperties: false,
						},
						// Strict mode would additionally require every property to be
						// listed in `required`, which callers are not obliged to do.
						// The schema is still enforced, just not to that letter.
						strict: false,
					},
				},
			},
			{ signal },
		);

		try {
			return JSON.parse(response.output_text) as unknown;
		} catch {
			// An empty or truncated body is a normal outcome, not an error worth
			// surfacing — the caller treats a null result as "nothing to report".
			return null;
		}
	}

	async testConnection(model: string): Promise<void> {
		// Deliberately tiny: a reasoning model will burn the whole ceiling before
		// saying anything and come back `incomplete`, which still proves the key and
		// the model name are good. Only an outright refusal is worth reporting.
		const response = await this.sdk().responses.create({
			model,
			max_output_tokens: 16,
			input: "Reply with the single word: ok",
			store: false,
		});
		if (findRefusal(response.output)) {
			throw new Error("The model declined the test request.");
		}
	}
}

/**
 * The Responses API rejects `summary` outright when the organisation has not
 * completed verification. The status alone is not enough to tell that apart from
 * an ordinary bad request, so the message is what identifies it.
 */
function isVerificationError(err: unknown): boolean {
	if (!(err instanceof OpenAI.APIError) || err.status !== 400) return false;
	const message = String(err.message).toLowerCase();
	return message.includes("verif") || message.includes("summar");
}

function findRefusal(output: OpenAI.Responses.ResponseOutputItem[]): string | null {
	for (const item of output) {
		if (item.type !== "message") continue;
		for (const block of item.content) {
			if (block.type === "refusal") return block.refusal;
		}
	}
	return null;
}

function toStopReason(
	response: OpenAI.Responses.Response,
	parts: ChatPart[],
	refusal: string | null,
): StopReason {
	if (refusal) return "refused";
	if (response.incomplete_details?.reason === "max_output_tokens") return "max_tokens";
	if (parts.some((p) => p.type === "tool_call")) return "tool_calls";
	return "end";
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.Responses.Tool[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: {
			type: "object",
			properties: tool.parameters.properties,
			required: tool.parameters.required ?? [],
		},
		// Strict mode requires every property to be required and nullable-typed,
		// which the vault tools' optional arguments are not.
		strict: false,
	}));
}

/**
 * Tool results may carry vault attachments. A `function_call_output` accepts a
 * list of content items rather than a bare string, so an image or PDF the model
 * asked for travels back through the normal tool path rather than a side channel.
 */
function toToolOutput(part: ToolResultPart): string | OpenAI.Responses.ResponseFunctionCallOutputItemList {
	// There is no error flag on a function call output, so a failure has to be
	// said in words for the model to notice it.
	const text = part.isError ? `Error: ${part.content}` : part.content;
	if (!part.media || part.media.length === 0) return text;

	const items: OpenAI.Responses.ResponseFunctionCallOutputItemList = [
		{ type: "input_text", text },
	];

	for (const item of part.media) {
		if (item.kind === "image") {
			items.push({
				type: "input_image",
				image_url: `data:${item.mediaType};base64,${item.data}`,
				detail: "auto",
			});
		} else {
			items.push({
				type: "input_file",
				// The filename is what the model sees as the document's identity, so
				// it gets the vault path rather than a generated name.
				filename: item.name,
				file_data: `data:${item.mediaType};base64,${item.data}`,
			});
		}
	}
	return items;
}

/**
 * The Responses API takes one flat list of items rather than role-grouped
 * messages, so a turn's parts are spread into siblings: reasoning, then text,
 * then any calls it made. Tool results are items in their own right and do not
 * belong to the user message that follows them.
 */
function toOpenAIInput(messages: ChatMessage[]): OpenAI.Responses.ResponseInput {
	const input: OpenAI.Responses.ResponseInput = [];

	for (const message of messages) {
		if (message.role === "user") {
			const content: OpenAI.Responses.ResponseInputMessageContentList = [];
			for (const part of message.parts) {
				if (part.type === "text") {
					content.push({ type: "input_text", text: part.text });
				} else if (part.type === "tool_result") {
					input.push({
						type: "function_call_output",
						call_id: part.toolCallId,
						output: toToolOutput(part),
					});
				}
			}
			if (content.length > 0) input.push({ role: "user", content });
			continue;
		}

		// Walked in the order the model produced them: a turn can alternate between
		// reasoning and tool calls, and each reasoning item belongs to the call that
		// follows it. Reasoning is replayed exactly as the API produced it —
		// encrypted payload included — so the stored original is used and anything
		// without one is dropped rather than reconstructed. Blocks saved by another
		// provider are shaped differently and are skipped.
		for (const part of message.parts) {
			if (part.type === "thinking") {
				if (isReasoningItem(part.raw)) input.push(part.raw);
			} else if (part.type === "text" && part.text) {
				input.push({ role: "assistant", content: part.text });
			} else if (part.type === "tool_call") {
				input.push({
					type: "function_call",
					call_id: part.id,
					name: part.name,
					arguments: JSON.stringify(part.input),
				});
			}
		}
	}

	return input;
}

/**
 * Saved chats are replayed from disk and can predate a provider switch, so the
 * opaque block on a thinking part is checked before being handed back to the API
 * rather than trusted to be ours.
 */
function isReasoningItem(raw: unknown): raw is OpenAI.Responses.ResponseReasoningItem {
	return (
		typeof raw === "object" &&
		raw !== null &&
		(raw as { type?: unknown }).type === "reasoning"
	);
}

function fromOpenAIOutput(output: OpenAI.Responses.ResponseOutputItem[]): ChatPart[] {
	const parts: ChatPart[] = [];

	for (const item of output) {
		switch (item.type) {
			case "reasoning": {
				// Summaries are what the user reads; `content` is the verbatim
				// reasoning some models return instead. Either can be absent, and an
				// item with neither still has to be replayed for its encrypted payload.
				const summary = item.summary.map((s) => s.text).filter(Boolean);
				const verbatim = (item.content ?? []).map((c) => c.text).filter(Boolean);
				parts.push({
					type: "thinking",
					text: (summary.length > 0 ? summary : verbatim).join("\n\n"),
					raw: item,
				});
				break;
			}
			case "message":
				for (const block of item.content) {
					if (block.type === "output_text") parts.push({ type: "text", text: block.text });
				}
				break;
			case "function_call":
				parts.push({
					type: "tool_call",
					id: item.call_id,
					name: item.name,
					input: parseArguments(item.arguments),
				});
				break;
			default:
				break;
		}
	}

	return parts;
}

/** Arguments arrive as a JSON string, which a truncated response can cut short. */
function parseArguments(args: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(args);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
