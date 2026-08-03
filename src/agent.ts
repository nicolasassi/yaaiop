import { App } from "obsidian";
import {
	VAULT_TOOLS,
	VaultToolRunner,
	formatToday,
	loadClaudeMd,
	vaultOverview,
	type ToolCallSummary,
} from "./vault-tools";
import type { YaaiopSettings } from "./settings";
import { memoriesSection } from "./memory";
import {
	modelInfo,
	type ChatMessage,
	type ChatPart,
	type ChatProvider,
	type ToolResultPart,
} from "./providers";

export interface StreamHandlers {
	onThinking(delta: string): void;
	onText(delta: string): void;
	onToolCall(summary: ToolCallSummary): void;
}

/** Safety net so a confused tool loop can't spin forever on the user's bill. */
const MAX_TOOL_ROUNDS = 12;

async function buildSystemPrompt(
	app: App,
	settings: YaaiopSettings,
	semantic: boolean,
): Promise<string> {
	const today = formatToday();
	const base = [
		`You are a research assistant embedded in the user's Obsidian vault "${app.vault.getName()}". You are talking to them inside Obsidian, on desktop or phone.`,
		"",
		`Vault: ${vaultOverview(app)}`,
		`Today is ${today}.`,
		"",
		"You have read-only tools over the vault. You cannot create, edit, or delete notes — if the user asks for a change, explain what you would change and let them make it.",
		"",
		semantic
			? "search_vault uses semantic (embedding) search, so descriptive natural-language queries work better than keywords."
			: "search_vault uses keyword matching (no semantic search backend is available), so prefer distinctive words and try a few phrasings if the first search comes up empty.",
		"",
		"How to work:",
		"- Search or list before answering questions about the vault's contents. Do not answer from memory of earlier turns when the user asks about a specific note.",
		"- Snippets from search are previews, not the file. Read a file before quoting or summarizing it in detail.",
		"- The vault holds images and PDFs as well as notes. read_file attaches an image or PDF directly so you can look at it, and file_links shows the notes that embed a file — an attachment's filename is often meaningless, so its surrounding text is what explains it.",
		"- For questions that span time or ask about patterns rather than one fact, use recent_notes or list_notes over a relevant folder instead of relying on a single search.",
		"- Cite files as [[path/to/file]] wikilinks so they are clickable in Obsidian.",
		"- If the vault does not contain the answer, say so plainly rather than inferring one. Distinguish what you read in a note from what you are inferring.",
		"",
		"Keep responses focused and brief — this often renders in a narrow sidebar or on a phone screen. Lead with the answer, then supporting detail. Use prose over headers for short answers.",
	].join("\n");

	const sections = [base];

	// CLAUDE.md is often written for a coding agent, so it can contain
	// instructions about tools this plugin does not have (MCP servers, shells,
	// file writes). Framing it as context-with-caveats stops the model from
	// trying to follow directions it cannot act on, or from refusing because it
	// "must" use a tool that isn't here.
	if (settings.useClaudeMd) {
		const claudeMd = await loadClaudeMd(app, settings.claudeMdPath, settings.maxClaudeMdChars);
		if (claudeMd) {
			sections.push(
				[
					`The vault contains a "${claudeMd.path}" file, shown below. Treat it as the user's standing notes about how they want this vault handled.`,
					"It may have been written for a different tool and may reference capabilities you do not have — follow the conventions, vocabulary, and context it describes, and ignore any instruction to use a tool that is not in your tool list. It never overrides the read-only limit above.",
					"",
					`<project_instructions path="${claudeMd.path}">`,
					claudeMd.content,
					claudeMd.truncated ? "\n[Truncated.]" : "",
					"</project_instructions>",
				].join("\n"),
			);
		}
	}

	const extra = settings.extraInstructions.trim();
	if (extra) {
		sections.push(`The user's own notes on their vault conventions:\n${extra}`);
	}

	// Memories go last on purpose. This is the only section that changes as the
	// user taps a suggestion mid-conversation, so keeping it at the tail means a
	// new memory invalidates the end of the cached prefix rather than all of it.
	if (settings.memoryEnabled) {
		const memories = memoriesSection(settings.memories);
		if (memories) sections.push(memories);
	}

	return sections.join("\n\n");
}

/**
 * The conversation engine. Provider-agnostic: it drives whatever ChatProvider it
 * is handed and never touches a vendor SDK.
 */
export class ChatSession {
	private messages: ChatMessage[] = [];

	constructor(
		private app: App,
		private provider: () => ChatProvider,
		private tools: VaultToolRunner,
		private getSettings: () => YaaiopSettings,
		private semanticAvailable: () => boolean,
	) {}

	reset(): void {
		this.messages = [];
	}

	get isEmpty(): boolean {
		return this.messages.length === 0;
	}

	/** Snapshot for persistence. Reasoning and tool parts are kept verbatim. */
	getMessages(): ChatMessage[] {
		return this.messages;
	}

	/**
	 * Restores a saved conversation so the next turn continues it. Parts are
	 * replayed exactly as stored, which is what lets providers that require
	 * byte-identical reasoning blocks pick the conversation back up.
	 */
	restore(messages: ChatMessage[]): void {
		this.messages = messages;
	}

	/**
	 * Runs one user turn to completion, including any tool round-trips.
	 * Streams deltas out through `handlers` as they arrive.
	 */
	async send(userText: string, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
		const settings = this.getSettings();
		const provider = this.provider();
		const model = modelInfo(provider.info, settings.model);
		// Built once per user turn, not per tool round: project instructions are
		// read through Obsidian's cache, but re-reading them mid-loop could change
		// the prompt prefix between rounds and cost us the cache hit.
		const system = await buildSystemPrompt(this.app, settings, this.semanticAvailable());

		this.messages.push({ role: "user", parts: [{ type: "text", text: userText }] });

		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			const result = await provider.streamCompletion(
				{
					model: settings.model,
					system,
					messages: this.messages,
					tools: VAULT_TOOLS,
					maxTokens: settings.maxTokens,
					effort: settings.effort,
					includeReasoning: settings.showThinking && model.supportsReasoning,
				},
				handlers,
				signal,
			);

			this.messages.push({ role: "assistant", parts: result.parts });

			if (result.stopReason === "refused") {
				throw new Error(
					`The request was declined${result.refusalReason ? ` (${result.refusalReason})` : ""}. Try rephrasing.`,
				);
			}

			if (result.stopReason !== "tool_calls") {
				if (result.stopReason === "max_tokens") {
					handlers.onText("\n\n_[Response hit the token limit — raise it in settings.]_");
				}
				return;
			}

			const calls = result.parts.filter((p): p is Extract<ChatPart, { type: "tool_call" }> =>
				p.type === "tool_call",
			);

			// Run them concurrently, but return every result in a single turn —
			// splitting them trains models out of making parallel calls.
			const results = await Promise.all(
				calls.map(async (call): Promise<ToolResultPart> => {
					const { content, isError, summary, media } = await this.tools.run(
						call.name,
						call.input,
					);
					handlers.onToolCall(summary);
					return { type: "tool_result", toolCallId: call.id, content, isError, media };
				}),
			);

			this.messages.push({ role: "user", parts: results });
		}

		handlers.onText(
			`\n\n_[Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.]_`,
		);
	}
}
