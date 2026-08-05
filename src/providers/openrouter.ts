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

const BASE_URL = "https://openrouter.ai/api/v1";

export const OPENROUTER_PROVIDER: ProviderInfo = {
	id: "openrouter",
	name: "OpenRouter",
	// Strong, multimodal, and an order of magnitude cheaper than the frontier
	// models below it. OpenRouter exists so people can pick, so the default only
	// has to be a sensible starting point rather than the most capable option.
	defaultModel: "google/gemini-3.6-flash",
	utilityModel: "google/gemini-3.5-flash-lite",
	apiKeyUrl: "https://openrouter.ai/keys",
	apiKeyPlaceholder: "sk-or-v1-...",
	// A cross-section of what OpenRouter carries rather than a catalogue: it
	// serves hundreds of models, and the model picker is a dropdown.
	models: [
		{
			id: "anthropic/claude-opus-5",
			label: "Claude Opus 5",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "anthropic/claude-sonnet-5",
			label: "Claude Sonnet 5",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "openai/gpt-5.6-sol",
			label: "GPT-5.6 Sol",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "google/gemini-3.6-flash",
			label: "Gemini 3.6 Flash (balanced)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "x-ai/grok-4.5",
			label: "Grok 4.5",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "moonshotai/kimi-k3",
			label: "Kimi K3 (no PDFs)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: false,
		},
		{
			id: "google/gemini-3.5-flash-lite",
			label: "Gemini 3.5 Flash-Lite (cheapest)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "deepseek/deepseek-v4-flash-0731",
			label: "DeepSeek V4 Flash (text only)",
			supportsReasoning: true,
			supportsImages: false,
			supportsDocuments: false,
		},
	],
};

/**
 * One block of a model's reasoning, in OpenRouter's normalised form.
 *
 * The shape varies by upstream vendor — a summary, an encrypted blob, or signed
 * text — and the whole sequence has to come back untouched on the next turn or
 * models that sign their reasoning reject it. Only `index` is read here, to
 * reassemble blocks split across streaming chunks; the rest is passed through.
 */
interface ReasoningDetail {
	type: string;
	index?: number;
	text?: string;
	summary?: string;
	data?: string;
	[key: string]: unknown;
}

/** Fields OpenRouter adds to the OpenAI-shaped request it accepts. */
type OpenRouterParams = OpenAI.Chat.ChatCompletionCreateParamsStreaming & {
	reasoning?: { effort?: string; exclude?: boolean };
};

/** Fields OpenRouter adds to the OpenAI-shaped chunks it returns. */
interface OpenRouterDelta {
	reasoning?: string | null;
	reasoning_details?: ReasoningDetail[];
}

/** Assistant turns carry their reasoning back up alongside the usual fields. */
type OpenRouterAssistantMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
	reasoning_details?: ReasoningDetail[];
};

export class OpenRouterProvider implements ChatProvider {
	readonly info = OPENROUTER_PROVIDER;
	private client: OpenAI | null = null;

	constructor(private getApiKey: () => string) {}

	isConfigured(): boolean {
		return this.getApiKey().length > 0;
	}

	reset(): void {
		this.client = null;
	}

	private sdk(): OpenAI {
		if (this.client) return this.client;

		const apiKey = this.getApiKey();
		if (!apiKey) throw new Error("No API key set. Add one in the plugin settings.");

		// OpenRouter speaks the OpenAI wire format, so the OpenAI SDK drives it with
		// nothing but a different base URL. Browser calls are supported outright —
		// it answers preflights with `access-control-allow-origin: *` and allows the
		// SDK's own headers.
		this.client = new OpenAI({
			apiKey,
			baseURL: BASE_URL,
			dangerouslyAllowBrowser: true,
			maxRetries: 2,
			// Attribution headers OpenRouter uses to credit traffic to an app. Not
			// telemetry: nothing about the user or their vault is in them.
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/nicolasassi/yaaiop",
				"X-Title": "YAAIOP for Obsidian",
			},
		});
		return this.client;
	}

	async streamCompletion(
		request: CompletionRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<CompletionResult> {
		const model = this.info.models.find((m) => m.id === request.model);

		const params: OpenRouterParams = {
			model: request.model,
			messages: [
				{ role: "system", content: request.system },
				...toOpenRouterMessages(request.messages),
			],
			tools: toOpenRouterTools(request.tools),
			max_tokens: request.maxTokens,
			stream: true,
		};

		if (model?.supportsReasoning) {
			// OpenRouter takes the same five levels this plugin exposes and works out
			// what each upstream vendor wants, so nothing has to be mapped here.
			params.reasoning = { effort: request.effort, exclude: !request.includeReasoning };
		}

		const stream = await this.sdk().chat.completions.create(params, { signal });

		let text = "";
		let reasoning = "";
		const details = new ReasoningAccumulator();
		const calls = new ToolCallAccumulator();
		let finishReason: string | null = null;

		for await (const chunk of stream) {
			const choice = chunk.choices[0];
			if (!choice) continue;
			finishReason = choice.finish_reason ?? finishReason;

			const delta = choice.delta as typeof choice.delta & OpenRouterDelta;

			if (delta.content) {
				text += delta.content;
				callbacks.onText(delta.content);
			}
			if (delta.reasoning) {
				reasoning += delta.reasoning;
				if (request.includeReasoning) callbacks.onThinking(delta.reasoning);
			}
			if (delta.reasoning_details) details.add(delta.reasoning_details);
			if (delta.tool_calls) calls.add(delta.tool_calls);
		}

		const parts: ChatPart[] = [];
		const collected = details.finish();
		// Reasoning leads the turn, matching the order the model produced it in.
		// A turn can have signed reasoning with no readable text — that still has to
		// be replayed, so the part is kept even when there is nothing to show.
		if (reasoning || collected.length > 0) {
			parts.push({ type: "thinking", text: reasoning, raw: collected.length > 0 ? collected : undefined });
		}
		if (text) parts.push({ type: "text", text });
		for (const call of calls.finish()) parts.push(call);

		const stopReason = toStopReason(finishReason, parts);

		return {
			// A call from a truncated or filtered turn will never be run, and leaving
			// it behind would mean a tool call with no matching result — which the
			// API rejects on the next turn.
			parts: stopReason === "tool_calls" ? parts : parts.filter((p) => p.type !== "tool_call"),
			stopReason,
			refusalReason: stopReason === "refused" ? (finishReason ?? undefined) : undefined,
		};
	}

	/**
	 * Structured Outputs, which OpenRouter normalises across the vendors that
	 * support it. No reasoning is asked for — utility models are picked for being
	 * cheap, and reasoning comes out of the same budget as the answer.
	 */
	async structuredCompletion(request: StructuredRequest, signal: AbortSignal): Promise<unknown> {
		const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
			reasoning?: { effort?: string };
		} = {
			model: request.model,
			messages: [
				{ role: "system", content: request.system },
				{ role: "user", content: request.prompt },
			],
			max_tokens: request.maxTokens,
			reasoning: { effort: "low" },
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "respond",
					schema: {
						type: "object",
						properties: request.schema.properties,
						required: request.schema.required ?? [],
						additionalProperties: false,
					},
					// Strict mode would additionally require every property to be
					// listed in `required`, which callers are not obliged to do.
					strict: false,
				},
			},
		};

		const response = await this.sdk().chat.completions.create(params, { signal });

		try {
			return JSON.parse(response.choices[0]?.message.content ?? "") as unknown;
		} catch {
			// An empty or truncated body is a normal outcome, not an error worth
			// surfacing — the caller treats a null result as "nothing to report".
			return null;
		}
	}

	async testConnection(model: string): Promise<void> {
		const response = await this.sdk().chat.completions.create({
			model,
			max_tokens: 16,
			messages: [{ role: "user", content: "Reply with the single word: ok" }],
		});
		if (response.choices[0]?.finish_reason === "content_filter") {
			throw new Error("The model declined the test request.");
		}
	}
}

/**
 * Reassembles reasoning blocks that arrive split across streaming chunks.
 *
 * Blocks are keyed by their `index`; text-bearing fields concatenate and
 * everything else is taken as it comes. The result has to be a faithful copy of
 * what the model produced, since that is what gets sent back.
 */
class ReasoningAccumulator {
	private byIndex = new Map<number, ReasoningDetail>();
	private order: number[] = [];

	add(details: ReasoningDetail[]): void {
		for (const detail of details) {
			const index = detail.index ?? this.order.length;
			const existing = this.byIndex.get(index);
			if (!existing) {
				this.byIndex.set(index, { ...detail });
				this.order.push(index);
				continue;
			}
			for (const [key, value] of Object.entries(detail)) {
				if (typeof value === "string" && typeof existing[key] === "string" && isTextField(key)) {
					existing[key] = (existing[key] as string) + value;
				} else if (value !== undefined && value !== null) {
					existing[key] = value;
				}
			}
		}
	}

	finish(): ReasoningDetail[] {
		return this.order.map((index) => this.byIndex.get(index)).filter((d): d is ReasoningDetail => !!d);
	}
}

/** Only these grow across chunks; ids, formats and signatures replace instead. */
function isTextField(key: string): boolean {
	return key === "text" || key === "summary" || key === "data";
}

/** Tool calls stream as fragments too, with arguments arriving a piece at a time. */
class ToolCallAccumulator {
	private byIndex = new Map<number, { id: string; name: string; args: string }>();

	add(deltas: OpenAI.Chat.ChatCompletionChunk.Choice.Delta.ToolCall[]): void {
		for (const delta of deltas) {
			const existing = this.byIndex.get(delta.index) ?? { id: "", name: "", args: "" };
			if (delta.id) existing.id = delta.id;
			if (delta.function?.name) existing.name = delta.function.name;
			if (delta.function?.arguments) existing.args += delta.function.arguments;
			this.byIndex.set(delta.index, existing);
		}
	}

	finish(): Extract<ChatPart, { type: "tool_call" }>[] {
		return [...this.byIndex.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, call]) => ({
				type: "tool_call" as const,
				id: call.id,
				name: call.name,
				input: parseArguments(call.args),
			}));
	}
}

function toStopReason(finishReason: string | null, parts: ChatPart[]): StopReason {
	if (finishReason === "content_filter") return "refused";
	if (finishReason === "length") return "max_tokens";
	if (parts.some((p) => p.type === "tool_call")) return "tool_calls";
	return "end";
}

function toOpenRouterTools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: {
				type: "object",
				properties: tool.parameters.properties,
				required: tool.parameters.required ?? [],
			},
		},
	}));
}

/**
 * Chat Completions has no way to put an image or a PDF inside a tool result —
 * a `tool` message is text and nothing else. Attachments therefore follow the
 * results as one extra user message, labelled so the model can tell it is
 * looking at what the tool returned rather than something the user sent.
 */
function toAttachmentMessage(
	results: ToolResultPart[],
): OpenAI.Chat.ChatCompletionUserMessageParam | null {
	const media = results.flatMap((r) => r.media ?? []);
	if (media.length === 0) return null;

	const content: OpenAI.Chat.ChatCompletionContentPart[] = [
		{
			type: "text",
			text: "Files returned by the tool calls above, in order:",
		},
	];

	for (const item of media) {
		if (item.kind === "image") {
			content.push({
				type: "image_url",
				image_url: { url: `data:${item.mediaType};base64,${item.data}` },
			});
		} else {
			content.push({
				type: "file",
				// The filename is the document's identity to the model, so it gets the
				// vault path rather than a generated name.
				file: { filename: item.name, file_data: `data:${item.mediaType};base64,${item.data}` },
			});
		}
	}

	return { role: "user", content };
}

function toOpenRouterMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
	const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const results: ToolResultPart[] = [];
			for (const part of message.parts) {
				if (part.type === "text") {
					out.push({ role: "user", content: part.text });
				} else if (part.type === "tool_result") {
					results.push(part);
					out.push({
						role: "tool",
						tool_call_id: part.toolCallId,
						// There is no error flag on a tool message, so a failure has to
						// be said in words for the model to notice it.
						content: part.isError ? `Error: ${part.content}` : part.content,
					});
				}
			}
			const attachments = toAttachmentMessage(results);
			if (attachments) out.push(attachments);
			continue;
		}

		const assistant: OpenRouterAssistantMessage = { role: "assistant" };
		const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

		for (const part of message.parts) {
			if (part.type === "thinking") {
				// The whole sequence has to match what the model produced, so the
				// stored original is sent and anything else is dropped rather than
				// reconstructed. Blocks saved by another provider are shaped
				// differently and are skipped.
				if (isReasoningDetails(part.raw)) assistant.reasoning_details = part.raw;
			} else if (part.type === "text" && part.text) {
				assistant.content = part.text;
			} else if (part.type === "tool_call") {
				toolCalls.push({
					id: part.id,
					type: "function",
					function: { name: part.name, arguments: JSON.stringify(part.input) },
				});
			}
		}

		if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
		// An assistant turn with neither content nor calls is not a valid message.
		if (assistant.content || toolCalls.length > 0) out.push(assistant);
	}

	return out;
}

/**
 * Saved chats are replayed from disk and can predate a provider switch, so the
 * opaque block on a thinking part is checked before being handed back to the API
 * rather than trusted to be ours.
 */
function isReasoningDetails(raw: unknown): raw is ReasoningDetail[] {
	return (
		Array.isArray(raw) &&
		raw.every(
			(d) => typeof d === "object" && d !== null && typeof (d as ReasoningDetail).type === "string",
		)
	);
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
