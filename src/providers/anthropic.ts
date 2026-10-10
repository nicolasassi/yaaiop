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
	WebSource,
} from "./types";
import { partsToText } from "./types";

/**
 * Models whose policy declines are rerouted server-side (`fallbacks: "default"`).
 * Kept to models whose default fallback route is documented, since naming one
 * without a route is a 400 rather than a no-op.
 */
const SERVER_FALLBACK_MODELS = new Set([
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
]);

/**
 * Models that sign each thinking block against the conversation before it and
 * reject a replay whose history changed since. They are told to drop such a
 * block instead of failing the request; the turn then runs without that
 * reasoning rather than not at all.
 */
const BOUND_THINKING_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);

/**
 * Models documented for the dynamic-filtering web tools, which trim search
 * results and fetched pages down before they reach the context. Everything else
 * gets the basic versions, which every model in the list accepts.
 */
const DYNAMIC_WEB_TOOL_MODELS = new Set([
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-opus-4-8",
]);

/**
 * Per request, not per turn. Enough for a search, a follow-up, and reading a few
 * of the results; a runaway loop stops here instead of on the user's bill.
 */
const MAX_WEB_SEARCHES = 5;
const MAX_WEB_FETCHES = 5;

export const ANTHROPIC_PROVIDER: ProviderInfo = {
	id: "anthropic",
	name: "Anthropic (Claude)",
	defaultModel: "claude-opus-5-5",
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
			id: "claude-opus-5-5",
			label: "Claude Opus 5.5 (recommended)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "claude-sonnet-5-5",
			label: "Claude Sonnet 5.5 (balanced)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "claude-opus-5",
			label: "Claude Opus 5",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "claude-sonnet-5",
			label: "Claude Sonnet 5",
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
			messages: toAnthropicMessages(request.messages, request.webAccess),
			tools: [
				...toAnthropicTools(request.tools),
				...(request.webAccess ? webTools(request.model) : []),
			],
			// Auto-caches the last cacheable block, so each turn re-reads the
			// system prompt and prior history from cache instead of paying full
			// price. Tool results are large; this matters.
			cache_control: { type: "ephemeral" },
			stream: true,
		};

		// Older models reject `thinking` and `output_config` outright, so they are
		// only sent for models that advertise reasoning support.
		const betas: Anthropic.Beta.AnthropicBeta[] = [];

		if (model?.supportsReasoning) {
			params.thinking = {
				type: "adaptive",
				// Without this, thinking blocks stream with empty text and the UI
				// shows a long pause before the first token of the answer.
				display: request.includeReasoning ? "summarized" : "omitted",
			};
			params.output_config = { effort: request.effort };

			// The session keeps history append-only, but a chat saved by an older
			// version, or one whose model changed midway, can still carry blocks
			// the API no longer accepts. Dropping them beats a 400.
			if (BOUND_THINKING_MODELS.has(request.model)) {
				params.thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
				betas.push("thinking-binding-controls-2026-08-01");
			}
		}

		// A policy decline is re-run server-side on a model Anthropic picks for that
		// refusal category, inside the same stream, instead of ending the turn.
		// Rate limits and outages are never rerouted — only declines.
		if (SERVER_FALLBACK_MODELS.has(request.model)) {
			betas.push("server-side-fallback-2026-07-01");
			params.fallbacks = "default";
		}

		if (betas.length > 0) params.betas = betas;

		let message: Anthropic.Beta.BetaMessage;
		try {
			message = await this.stream(params, request, callbacks, signal);
		} catch (err) {
			// Models without the drop option reject a stale reasoning block outright.
			// The 400 arrives before any output has streamed, so the turn can be
			// re-sent once without reasoning and the user sees only the answer.
			if (!isThinkingSignatureError(err)) throw err;
			console.warn("[yaaiop] replayed reasoning was rejected; retrying without it.", err);
			message = await this.stream(
				{ ...params, messages: withoutThinking(params.messages) },
				request,
				callbacks,
				signal,
			);
		}

		return {
			parts: fromAnthropicContent(message.content),
			stopReason: toStopReason(message.stop_reason),
			refusalReason: message.stop_details?.category ?? undefined,
			sources: citedSources(message.content),
		};
	}

	private async stream(
		params: Anthropic.Beta.Messages.MessageCreateParamsStreaming,
		request: CompletionRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<Anthropic.Beta.BetaMessage> {
		const stream = this.sdk().beta.messages.stream(params, { signal });

		for await (const event of stream) {
			if (event.type !== "content_block_delta") continue;
			if (event.delta.type === "text_delta") {
				callbacks.onText(event.delta.text);
			} else if (event.delta.type === "thinking_delta" && request.includeReasoning) {
				callbacks.onThinking(event.delta.thinking);
			}
		}

		return stream.finalMessage();
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
		// The server-side search loop hit its iteration limit mid-turn.
		case "pause_turn":
			return "paused";
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

/**
 * Search and fetch run on Anthropic's side; the model calls them like any tool
 * but the results come back inside the same response. Fetch only opens URLs
 * already in the conversation — typed by the user or found by a search — so it
 * cannot be steered to an address the model made up.
 */
function webTools(model: string): Anthropic.Beta.BetaToolUnion[] {
	if (DYNAMIC_WEB_TOOL_MODELS.has(model)) {
		return [
			{ type: "web_search_20260209", name: "web_search", max_uses: MAX_WEB_SEARCHES },
			{ type: "web_fetch_20260209", name: "web_fetch", max_uses: MAX_WEB_FETCHES },
		];
	}
	return [
		{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_SEARCHES },
		{ type: "web_fetch_20250910", name: "web_fetch", max_uses: MAX_WEB_FETCHES },
	];
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

/**
 * `webAccess` gates replaying earlier searches: with the web tools switched off
 * they are no longer declared, and a call to an undeclared tool is rejected.
 * The answer text they led to is kept either way.
 */
function toAnthropicMessages(messages: ChatMessage[], webAccess: boolean): Anthropic.MessageParam[] {
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

		// Each thinking block is signed against everything before it, so the turn
		// goes back exactly as the API produced it: same blocks, same order, the
		// stored originals rather than anything rebuilt from the parts. Reasoning
		// without a signature is dropped rather than reconstructed, and blocks
		// saved by another provider are shaped differently and are skipped.
		const content: Anthropic.ContentBlockParam[] = [];
		for (const part of message.parts) {
			if (part.type === "thinking") {
				if (isThinkingBlock(part.raw)) content.push(part.raw);
			} else if (part.type === "text") {
				if (isTextBlocks(part.raw)) content.push(...part.raw);
				else if (part.text) content.push({ type: "text", text: part.text });
			} else if (part.type === "tool_call") {
				content.push(
					isToolUseBlock(part.raw, part.id)
						? part.raw
						: { type: "tool_use", id: part.id, name: part.name, input: part.input },
				);
			} else if (part.type === "server_tool" && webAccess && isServerBlock(part.raw)) {
				// The call and its result, encrypted page content included, go back
				// as they came — the model otherwise forgets what it read mid-turn.
				content.push(part.raw);
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

/** The original text blocks behind a text part, when this adapter made it. */
function isTextBlocks(raw: unknown): raw is Anthropic.TextBlockParam[] {
	return (
		Array.isArray(raw) &&
		raw.length > 0 &&
		raw.every(
			(block) =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
	);
}

/** The original `tool_use` block behind a tool call, when this adapter made it. */
function isToolUseBlock(raw: unknown, id: string): raw is Anthropic.ToolUseBlockParam {
	if (typeof raw !== "object" || raw === null) return false;
	const block = raw as { type?: unknown; id?: unknown };
	return block.type === "tool_use" && block.id === id;
}

/**
 * The 400 for a reasoning block the API will not accept back: bound to a
 * different conversation, or a signature it cannot verify. Both read
 * "Invalid `signature` in `thinking` block".
 */
function isThinkingSignatureError(err: unknown): boolean {
	return (
		err instanceof Anthropic.BadRequestError &&
		/signature/i.test(err.message) &&
		/thinking/i.test(err.message)
	);
}

/** History with every reasoning block removed; text and tool calls stay. */
function withoutThinking(
	messages: Anthropic.Beta.BetaMessageParam[],
): Anthropic.Beta.BetaMessageParam[] {
	return messages.map((message) =>
		message.role === "assistant" && Array.isArray(message.content)
			? {
					...message,
					content: message.content.filter(
						(block) => block.type !== "thinking" && block.type !== "redacted_thinking",
					),
				}
			: message,
	);
}

/**
 * Blocks from a server-side tool: the `server_tool_use` call, and a result block
 * whose type ends in `_tool_result`. A client `tool_result` never appears in an
 * assistant turn, so the suffix alone does not catch one.
 */
function isServerBlock(raw: unknown): raw is Anthropic.ContentBlockParam {
	if (typeof raw !== "object" || raw === null) return false;
	const type = (raw as { type?: unknown }).type;
	return (
		typeof type === "string" &&
		(type === "server_tool_use" || (type.endsWith("_tool_result") && type !== "tool_result"))
	);
}

/** One row per search or fetch; the internal steps behind them get none. */
function serverToolDetail(block: { name: string; input: unknown }): string {
	const input = (block.input ?? {}) as Record<string, unknown>;
	if (block.name === "web_search" && typeof input.query === "string") return `"${input.query}"`;
	if (block.name === "web_fetch" && typeof input.url === "string") return input.url;
	return "";
}

/** Pages the answer cites. Claude attaches them to text blocks, not the text. */
function citedSources(content: Array<Anthropic.ContentBlock | Anthropic.Beta.BetaContentBlock>): WebSource[] {
	const sources: WebSource[] = [];
	for (const block of content) {
		if (block.type !== "text" || !block.citations) continue;
		for (const citation of block.citations) {
			if (citation.type === "web_search_result_location") {
				sources.push({ url: citation.url, title: citation.title ?? undefined });
			}
		}
	}
	return sources;
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
			case "text": {
				// A cited answer arrives as many short text blocks, one per claim.
				// They are one piece of prose, streamed without separators, so they
				// are shown as one — joined with nothing, exactly as they streamed —
				// while the blocks themselves are kept for replay, citations included.
				const last = parts[parts.length - 1];
				if (last?.type === "text" && Array.isArray(last.raw)) {
					last.text += block.text;
					last.raw.push(block);
				} else {
					parts.push({ type: "text", text: block.text, raw: [block] });
				}
				break;
			}
			case "server_tool_use":
				parts.push({
					type: "server_tool",
					name: block.name,
					detail: serverToolDetail(block),
					raw: block,
				});
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
					raw: block,
				});
				break;
			default:
				if (isServerBlock(block)) {
					parts.push({ type: "server_tool", name: block.type, detail: "", raw: block });
				}
				break;
		}
	}
	return parts;
}
