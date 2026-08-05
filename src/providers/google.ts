import { FinishReason, GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { Content, FunctionResponsePart, GenerateContentResponse, Part } from "@google/genai";
import type {
	ChatMessage,
	ChatPart,
	ChatProvider,
	CompletionRequest,
	CompletionResult,
	ProviderInfo,
	ReasoningEffort,
	StopReason,
	StreamCallbacks,
	StructuredRequest,
	ToolDefinition,
	ToolResultPart,
} from "./types";

export const GOOGLE_PROVIDER: ProviderInfo = {
	id: "google",
	name: "Google (Gemini)",
	// The stable Flash rather than the more capable Pro, which is still a preview
	// model: previews are retired on short notice, and a default that stops
	// existing is worse than a default that is a step down in capability.
	defaultModel: "gemini-3.6-flash",
	utilityModel: "gemini-3.5-flash-lite",
	apiKeyUrl: "https://aistudio.google.com/apikey",
	apiKeyPlaceholder: "AIza...",
	models: [
		{
			id: "gemini-3.1-pro-preview",
			label: "Gemini 3.1 Pro (most capable, preview)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "gemini-3.6-flash",
			label: "Gemini 3.6 Flash (balanced)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
		{
			id: "gemini-3.5-flash-lite",
			label: "Gemini 3.5 Flash-Lite (fastest, cheapest)",
			supportsReasoning: true,
			supportsImages: true,
			supportsDocuments: true,
		},
	],
};

/**
 * Prefix for tool call ids this adapter invented.
 *
 * Gemini does not always put an id on a function call, but the neutral part
 * type requires one. A synthetic id is fine to store, and must not be sent back
 * as though the model had issued it — matching is by name in that case.
 */
const SYNTHETIC_ID = "yaaiop-";

/** Finish reasons that mean the model was stopped, not that it finished. */
const BLOCKED: ReadonlySet<string> = new Set<string>([
	FinishReason.SAFETY,
	FinishReason.RECITATION,
	FinishReason.BLOCKLIST,
	FinishReason.PROHIBITED_CONTENT,
	FinishReason.SPII,
	FinishReason.IMAGE_SAFETY,
	FinishReason.IMAGE_PROHIBITED_CONTENT,
	FinishReason.IMAGE_RECITATION,
	FinishReason.MALFORMED_FUNCTION_CALL,
	FinishReason.UNEXPECTED_TOOL_CALL,
]);

export class GoogleProvider implements ChatProvider {
	readonly info = GOOGLE_PROVIDER;
	private client: GoogleGenAI | null = null;

	constructor(private getApiKey: () => string) {}

	isConfigured(): boolean {
		return this.getApiKey().length > 0;
	}

	reset(): void {
		this.client = null;
	}

	private sdk(): GoogleGenAI {
		if (this.client) return this.client;

		const apiKey = this.getApiKey();
		if (!apiKey) throw new Error("No API key set. Add one in the plugin settings.");

		// No browser opt-in to set, unlike the other two adapters: this SDK ships a
		// web build that esbuild picks up, and generativelanguage.googleapis.com
		// echoes the caller's origin back in its CORS headers.
		this.client = new GoogleGenAI({ apiKey });
		return this.client;
	}

	async streamCompletion(
		request: CompletionRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<CompletionResult> {
		const model = this.info.models.find((m) => m.id === request.model);

		const stream = await this.sdk().models.generateContentStream({
			model: request.model,
			contents: toGeminiContents(request.messages),
			config: {
				systemInstruction: request.system,
				maxOutputTokens: request.maxTokens,
				tools: [{ functionDeclarations: toGeminiTools(request.tools) }],
				abortSignal: signal,
				...(model?.supportsReasoning
					? {
							thinkingConfig: {
								thinkingLevel: toThinkingLevel(request.effort),
								includeThoughts: request.includeReasoning,
							},
						}
					: {}),
			},
		});

		// There is no "final message" to ask for at the end, so the answer is
		// rebuilt from the deltas as they arrive.
		const accumulator = new PartAccumulator(callbacks, request.includeReasoning);
		let finishReason: string | undefined;
		let blockReason: string | undefined;

		for await (const chunk of stream) {
			blockReason ??= chunk.promptFeedback?.blockReason;
			const candidate = chunk.candidates?.[0];
			if (!candidate) continue;
			finishReason = candidate.finishReason ?? finishReason;
			for (const part of candidate.content?.parts ?? []) {
				accumulator.add(part);
			}
		}

		const parts = accumulator.finish();
		const refusal = blockReason ?? (finishReason && BLOCKED.has(finishReason) ? finishReason : undefined);
		const stopReason = toStopReason(finishReason, parts, refusal);

		return {
			// A call from a truncated or blocked turn will never be run, and leaving
			// it in the transcript would mean a function call with no response —
			// which the API rejects on the next turn.
			parts: stopReason === "tool_calls" ? parts : parts.filter((p) => p.type !== "tool_call"),
			stopReason,
			refusalReason: refusal,
		};
	}

	/**
	 * Gemini takes a JSON Schema and a response MIME type directly, so no tool is
	 * needed to pin the shape. Thinking is held to the lowest level the models
	 * accept — utility models are picked for being cheap, and reasoning is drawn
	 * from the same output budget as the answer, so a thoughtful one would spend
	 * the ceiling and return nothing.
	 */
	async structuredCompletion(request: StructuredRequest, signal: AbortSignal): Promise<unknown> {
		const response = await this.sdk().models.generateContent({
			model: request.model,
			contents: request.prompt,
			config: {
				systemInstruction: request.system,
				maxOutputTokens: request.maxTokens,
				abortSignal: signal,
				responseMimeType: "application/json",
				responseJsonSchema: {
					type: "object",
					properties: request.schema.properties,
					required: request.schema.required ?? [],
				},
				thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
			},
		});

		try {
			return JSON.parse(response.text ?? "") as unknown;
		} catch {
			// An empty or truncated body is a normal outcome, not an error worth
			// surfacing — the caller treats a null result as "nothing to report".
			return null;
		}
	}

	async testConnection(model: string): Promise<void> {
		// Deliberately tiny. A thinking model will spend the whole ceiling before
		// saying anything and come back MAX_TOKENS, which still proves the key and
		// the model name are good. Only a block is worth reporting.
		const response = await this.sdk().models.generateContent({
			model,
			contents: "Reply with the single word: ok",
			config: { maxOutputTokens: 16 },
		});

		const blocked = blockedReason(response);
		if (blocked) throw new Error(`The model declined the test request (${blocked}).`);
	}
}

function blockedReason(response: GenerateContentResponse): string | undefined {
	if (response.promptFeedback?.blockReason) return response.promptFeedback.blockReason;
	const finishReason = response.candidates?.[0]?.finishReason;
	return finishReason && BLOCKED.has(finishReason) ? finishReason : undefined;
}

/**
 * Rebuilds whole parts from streamed fragments.
 *
 * Text and reasoning arrive as deltas that have to be concatenated, while tool
 * calls arrive whole. Everything is kept in arrival order, because a turn can
 * alternate between them and a thought signature belongs to whichever part it
 * came with.
 */
class PartAccumulator {
	private parts: ChatPart[] = [];
	/** Signatures seen for the reasoning parts, by their index in `parts`. */
	private signatures = new Map<number, string>();

	constructor(
		private callbacks: StreamCallbacks,
		private includeReasoning: boolean,
	) {}

	add(part: Part): void {
		if (part.functionCall) {
			const call = part.functionCall;
			this.parts.push({
				type: "tool_call",
				id: call.id ?? `${SYNTHETIC_ID}${this.parts.length}`,
				name: call.name ?? "",
				input: call.args ?? {},
				// The signature rides on the call itself, and the next turn is
				// rejected without it.
				raw: part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined,
			});
			return;
		}

		if (part.text === undefined) return;

		const kind = part.thought ? "thinking" : "text";
		if (kind === "thinking" && !this.includeReasoning) return;

		const last = this.parts[this.parts.length - 1];
		if (last?.type === kind) {
			last.text += part.text;
		} else {
			this.parts.push(
				kind === "thinking"
					? { type: "thinking", text: part.text }
					: { type: "text", text: part.text },
			);
		}

		if (kind === "thinking") {
			this.callbacks.onThinking(part.text);
			// A signature can arrive on any fragment of the block; the last one wins,
			// since it is the one that covers the completed block.
			if (part.thoughtSignature) {
				this.signatures.set(this.parts.length - 1, part.thoughtSignature);
			}
		} else {
			this.callbacks.onText(part.text);
		}
		// A signature landing on a plain text part is dropped. Only reasoning and
		// tool calls are validated on replay, and the neutral text part has nowhere
		// to keep it.
	}

	finish(): ChatPart[] {
		for (const [index, signature] of this.signatures) {
			const part = this.parts[index];
			if (part?.type !== "thinking") continue;
			// Replayed verbatim next turn, so it is stored the way the API sends it.
			part.raw = { text: part.text, thought: true, thoughtSignature: signature };
		}
		return this.parts;
	}
}

/**
 * Our five-step scale onto Gemini's four. The top three collapse: Pro does not
 * accept anything above HIGH, so asking for more would be an error rather than
 * more thinking. MINIMAL is never sent — Pro rejects it.
 */
function toThinkingLevel(effort: ReasoningEffort): ThinkingLevel {
	switch (effort) {
		case "low":
			return ThinkingLevel.LOW;
		case "medium":
			return ThinkingLevel.MEDIUM;
		default:
			return ThinkingLevel.HIGH;
	}
}

function toStopReason(
	finishReason: string | undefined,
	parts: ChatPart[],
	refusal: string | undefined,
): StopReason {
	if (refusal) return "refused";
	if (finishReason === FinishReason.MAX_TOKENS) return "max_tokens";
	if (parts.some((p) => p.type === "tool_call")) return "tool_calls";
	return "end";
}

function toGeminiTools(tools: ToolDefinition[]) {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// Raw JSON Schema, rather than Gemini's own Schema type — the tools already
		// describe themselves that way and a translation layer could only lose
		// detail.
		parametersJsonSchema: {
			type: "object",
			properties: tool.parameters.properties,
			required: tool.parameters.required ?? [],
		},
	}));
}

/**
 * Tool results may carry vault attachments. A functionResponse takes media in
 * its own `parts`, so an image or PDF the model asked for travels back through
 * the normal tool path rather than a side channel.
 */
function toResponseParts(part: ToolResultPart): FunctionResponsePart[] | undefined {
	if (!part.media || part.media.length === 0) return undefined;
	return part.media.map((item) => ({
		inlineData: { mimeType: item.mediaType, data: item.data, displayName: item.name },
	}));
}

/**
 * Gemini alternates `user` and `model` turns, and tool results are user parts
 * rather than items of their own. A function response has to name the function
 * it answers, which the neutral part does not carry, so the name is recovered
 * from the call it belongs to as the history is walked.
 */
function toGeminiContents(messages: ChatMessage[]): Content[] {
	const contents: Content[] = [];
	const toolNames = new Map<string, string>();

	for (const message of messages) {
		const parts: Part[] = [];

		if (message.role === "user") {
			for (const part of message.parts) {
				if (part.type === "text") {
					parts.push({ text: part.text });
				} else if (part.type === "tool_result") {
					parts.push({
						functionResponse: {
							// Synthesised ids were never issued by the model; sending one
							// back would ask it to match against something it never said.
							...(part.toolCallId.startsWith(SYNTHETIC_ID)
								? {}
								: { id: part.toolCallId }),
							name: toolNames.get(part.toolCallId) ?? "",
							// There is no error flag on a function response, so a failure
							// has to be said in words for the model to notice it.
							response: part.isError
								? { error: part.content }
								: { output: part.content },
							parts: toResponseParts(part),
						},
					});
				}
			}
			if (parts.length > 0) contents.push({ role: "user", parts });
			continue;
		}

		// Walked in the order the model produced them: a turn can alternate between
		// reasoning and tool calls, and a thought signature belongs to the part it
		// arrived with. Blocks saved by another provider are shaped differently and
		// are skipped rather than replayed.
		for (const part of message.parts) {
			if (part.type === "thinking") {
				if (isThoughtPart(part.raw)) parts.push(part.raw);
			} else if (part.type === "text" && part.text) {
				parts.push({ text: part.text });
			} else if (part.type === "tool_call") {
				toolNames.set(part.id, part.name);
				parts.push({
					functionCall: {
						...(part.id.startsWith(SYNTHETIC_ID) ? {} : { id: part.id }),
						name: part.name,
						args: part.input,
					},
					...(isSignedPart(part.raw) ? { thoughtSignature: part.raw.thoughtSignature } : {}),
				});
			}
		}
		if (parts.length > 0) contents.push({ role: "model", parts });
	}

	return contents;
}

/**
 * Saved chats are replayed from disk and can predate a provider switch, so the
 * opaque block on a part is checked before being handed back to the API rather
 * than trusted to be ours.
 */
function isThoughtPart(raw: unknown): raw is Part {
	return typeof raw === "object" && raw !== null && (raw as Part).thought === true;
}

function isSignedPart(raw: unknown): raw is { thoughtSignature: string } {
	return (
		typeof raw === "object" &&
		raw !== null &&
		typeof (raw as { thoughtSignature?: unknown }).thoughtSignature === "string"
	);
}
