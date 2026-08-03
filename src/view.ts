import { ItemView, MarkdownRenderer, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type YaaiopPlugin from "./main";
import { ChatSession } from "./agent";
import { modelInfo, providerInfo, type ChatMessage, type TextPart, type ThinkingPart } from "./providers";
import { SessionHistoryModal } from "./modals";
import { deriveTitle, newSessionId, type StoredSession } from "./store";
import { largestFolder, type ToolCallSummary } from "./vault-tools";
import { MAX_MEMORIES, extractMemories, newMemory } from "./memory";

export const VIEW_TYPE_YAAIOP = "yaaiop-chat-view";

export class YaaiopView extends ItemView {
	private plugin: YaaiopPlugin;
	private session: ChatSession;

	private messagesEl!: HTMLElement;
	private memoryBarEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private statusEl!: HTMLElement;

	private controller: AbortController | null = null;
	/** Separate from `controller`: extraction outlives the turn that started it. */
	private memoryController: AbortController | null = null;
	/**
	 * Sticky across suggestions. Collapsing is a statement about wanting the
	 * chat back, not about one particular batch, so the next batch respects it.
	 */
	private memoryCollapsed = false;

	private sessionId = newSessionId();
	private sessionCreatedAt = Date.now();

	constructor(leaf: WorkspaceLeaf, plugin: YaaiopPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.session = plugin.createSession();
	}

	getViewType(): string {
		return VIEW_TYPE_YAAIOP;
	}

	getDisplayText(): string {
		return "AI chat";
	}

	getIcon(): string {
		return "message-circle";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("yaaiop-root");

		const header = root.createDiv({ cls: "yaaiop-header" });
		this.statusEl = header.createDiv({ cls: "yaaiop-status" });

		const actions = header.createDiv({ cls: "yaaiop-header-actions" });

		const history = actions.createEl("button", {
			cls: "yaaiop-icon-button",
			attr: { "aria-label": "Saved chats" },
		});
		setIcon(history, "history");
		history.onclick = () => this.openHistory();

		const newChat = actions.createEl("button", {
			cls: "yaaiop-icon-button",
			attr: { "aria-label": "New chat" },
		});
		setIcon(newChat, "plus");
		newChat.onclick = () => this.newChat();

		this.messagesEl = root.createDiv({ cls: "yaaiop-messages" });

		// Sits between the transcript and the composer so it is the last thing
		// read before typing, and never pushes a streaming answer around.
		this.memoryBarEl = root.createDiv({ cls: "yaaiop-memory-bar" });
		this.memoryBarEl.hide();

		const composer = root.createDiv({ cls: "yaaiop-composer" });
		this.inputEl = composer.createEl("textarea", {
			cls: "yaaiop-input",
			attr: {
				rows: "2",
				placeholder: Platform.isMobile
					? "Ask about your vault…"
					: "Ask about your vault…  (Enter to send, Shift+Enter for a new line)",
			},
		});

		this.sendButton = composer.createEl("button", {
			cls: "yaaiop-send",
			attr: { "aria-label": "Send" },
		});
		setIcon(this.sendButton, "arrow-up");
		this.sendButton.onclick = () => this.onSendOrStop();

		this.inputEl.addEventListener("keydown", (evt) => {
			// On phones Enter must insert a newline — the on-screen keyboard has no
			// modifier to hold, so sending is the button's job there.
			if (evt.key === "Enter" && !evt.shiftKey && !Platform.isMobile) {
				evt.preventDefault();
				this.onSendOrStop();
			}
		});

		this.inputEl.addEventListener("input", () => this.autoGrow());

		this.renderStatus();
		this.renderEmptyState();
	}

	async onClose(): Promise<void> {
		this.controller?.abort();
		this.memoryController?.abort();
	}

	private autoGrow(): void {
		// Measure against auto, then pin to the measured height.
		this.inputEl.setCssStyles({ height: "auto" });
		this.inputEl.setCssStyles({ height: `${Math.min(this.inputEl.scrollHeight, 160)}px` });
	}

	private renderStatus(): void {
		const settings = this.plugin.settings;
		const info = modelInfo(providerInfo(settings.providerId), settings.model);
		const search = this.plugin.search.smartConnectionsAvailable() && settings.preferSmartConnections
			? "semantic search"
			: "keyword search";
		this.statusEl.setText(`${info.label.split(" (")[0]} · ${search}`);
	}

	private renderEmptyState(): void {
		const empty = this.messagesEl.createDiv({ cls: "yaaiop-empty" });
		const saved = this.plugin.settings.savedPrompts.filter((p) => p.prompt.trim());

		if (saved.length > 0) {
			// The user's own openers take precedence — one tap starts the chat.
			empty.createEl("p", { text: "Start with a saved prompt, or just ask." });
			const list = empty.createEl("ul");
			for (const prompt of saved) {
				const li = list.createEl("li");
				const btn = li.createEl("button", {
					cls: "yaaiop-example",
					text: prompt.name || prompt.prompt.slice(0, 48),
				});
				btn.setAttribute("aria-label", prompt.prompt);
				btn.onclick = () => void this.send(prompt.prompt);
			}
			return;
		}

		empty.createEl("p", { text: "Ask about your notes." });
		const list = empty.createEl("ul");
		// Examples are built from this vault's own structure so they make sense
		// in any vault, rather than assuming a particular set of topics.
		const folder = largestFolder(this.app);
		const examples = [
			"What have I been working on this week?",
			folder
				? `What do my notes in ${folder} cover?`
				: "What are the main themes across my notes?",
			"Find notes where I wrote about the same idea in different places.",
		];
		for (const example of examples) {
			const li = list.createEl("li");
			const btn = li.createEl("button", { cls: "yaaiop-example", text: example });
			btn.onclick = () => {
				this.inputEl.value = example;
				this.autoGrow();
				this.inputEl.focus();
			};
		}
	}

	newChat(): void {
		this.controller?.abort();
		this.clearMemorySuggestions();
		this.session.reset();
		this.sessionId = newSessionId();
		this.sessionCreatedAt = Date.now();
		this.messagesEl.empty();
		this.renderEmptyState();
		this.renderStatus();
		this.inputEl.focus();
	}

	/** Starts a fresh chat and immediately sends `text` (used by saved prompts). */
	startWithPrompt(text: string): void {
		this.newChat();
		void this.send(text);
	}

	private openHistory(): void {
		new SessionHistoryModal(this.app, this.plugin.store, (stored) =>
			this.openSession(stored),
		).open();
	}

	/** Replaces the current conversation with a stored one and re-renders it. */
	openSession(stored: StoredSession): void {
		this.controller?.abort();
		this.clearMemorySuggestions();
		this.session.restore(stored.messages);
		this.sessionId = stored.id;
		this.sessionCreatedAt = stored.createdAt;

		this.messagesEl.empty();
		void this.renderStoredMessages(stored.messages).then(() => this.scrollToBottom());
		this.renderStatus();
	}

	/**
	 * Rebuilds the transcript from persisted messages. Tool traffic is collapsed
	 * to the same one-line rows used live, so a reopened chat reads the same as
	 * it did when it ran.
	 */
	private async renderStoredMessages(messages: ChatMessage[]): Promise<void> {
		for (const message of messages) {
			const text = message.parts
				.filter((p): p is TextPart => p.type === "text")
				.map((p) => p.text)
				.join("\n");

			if (message.role === "user") {
				// Skip tool-result-only turns; they carry no user-authored text.
				if (text.trim()) this.addUserMessage(text);
				continue;
			}

			const bubble = this.addAssistantMessage();

			const thinking = message.parts
				.filter((p): p is ThinkingPart => p.type === "thinking")
				.map((p) => p.text)
				.join("\n")
				.trim();
			if (thinking && this.plugin.settings.showThinking) bubble.setThinking(thinking);

			for (const part of message.parts) {
				if (part.type === "tool_call") {
					bubble.addToolCall({ name: part.name, detail: summariseInput(part.input) });
				}
			}

			await bubble.finalize(text);
		}
	}

	private async persistSession(): Promise<void> {
		if (!this.plugin.settings.persistSessions) return;
		const messages = this.session.getMessages();
		if (messages.length === 0) return;

		await this.plugin.store.save(
			{
				id: this.sessionId,
				title: deriveTitle(messages),
				createdAt: this.sessionCreatedAt,
				updatedAt: Date.now(),
				providerId: this.plugin.settings.providerId,
				model: this.plugin.settings.model,
				messages,
			},
			this.plugin.settings.maxStoredSessions,
		);
	}

	private onSendOrStop(): void {
		if (this.controller) {
			this.controller.abort();
			return;
		}
		void this.send();
	}

	private setStreaming(streaming: boolean): void {
		if (streaming) {
			setIcon(this.sendButton, "square");
			this.sendButton.setAttribute("aria-label", "Stop");
			this.sendButton.addClass("yaaiop-send-stop");
		} else {
			setIcon(this.sendButton, "arrow-up");
			this.sendButton.setAttribute("aria-label", "Send");
			this.sendButton.removeClass("yaaiop-send-stop");
		}
	}

	/** `preset` starts a turn without going through the composer (saved prompts). */
	private async send(preset?: string): Promise<void> {
		if (this.controller) return;

		const text = (preset ?? this.inputEl.value).trim();
		if (!text) return;

		if (!this.plugin.hasApiKey()) {
			new Notice("YAAIOP: add your API key in settings first.");
			return;
		}

		this.messagesEl.querySelector(".yaaiop-empty")?.remove();
		// Last turn's suggestions are about last turn. Asking a new question is
		// as good as dismissing them.
		this.clearMemorySuggestions();
		if (preset === undefined) this.inputEl.value = "";
		this.autoGrow();

		this.addUserMessage(text);
		const assistant = this.addAssistantMessage();

		this.controller = new AbortController();
		this.setStreaming(true);

		let thinkingText = "";
		let answerText = "";
		let completed = false;

		try {
			await this.session.send(
				text,
				{
					onThinking: (delta) => {
						thinkingText += delta;
						assistant.setThinking(thinkingText);
					},
					onText: (delta) => {
						answerText += delta;
						assistant.setStreamingText(answerText);
					},
					onToolCall: (summary) => assistant.addToolCall(summary),
				},
				this.controller.signal,
			);
			await assistant.finalize(answerText);
			completed = true;
		} catch (err) {
			const message = (err as Error).message ?? String(err);
			if (this.controller.signal.aborted) {
				await assistant.finalize(answerText);
				assistant.addNotice("Stopped.");
			} else {
				await assistant.finalize(answerText);
				assistant.addError(message);
			}
		} finally {
			this.controller = null;
			this.setStreaming(false);
			this.scrollToBottom();
			// Save after every turn, including a stopped or failed one — a
			// half-finished conversation is still worth being able to reopen.
			await this.persistSession();
		}

		// Only a turn that ran to a real answer is worth reading for memories,
		// and it is deliberately not awaited: it must not delay the composer.
		if (completed) void this.suggestMemories(text, answerText);
	}

	/**
	 * Looks at the finished exchange and offers anything worth keeping.
	 *
	 * Every failure here is swallowed to the console. This is a side feature the
	 * user did not ask for on this particular turn — a rate limit or a bad
	 * response from it must never surface as an error over a good answer.
	 */
	private async suggestMemories(userText: string, answerText: string): Promise<void> {
		const settings = this.plugin.settings;
		if (!settings.memoryEnabled) return;
		if (settings.memories.length >= MAX_MEMORIES) return;
		if (!answerText.trim()) return;

		this.memoryController?.abort();
		const controller = new AbortController();
		this.memoryController = controller;

		try {
			const candidates = await extractMemories(
				this.plugin.provider(),
				userText,
				answerText,
				settings.memories,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			if (candidates.length > 0) this.renderMemorySuggestions(candidates);
		} catch (err) {
			if (!controller.signal.aborted) {
				console.error("[yaaiop] could not check for memories:", err);
			}
		} finally {
			if (this.memoryController === controller) this.memoryController = null;
		}
	}

	private clearMemorySuggestions(): void {
		this.memoryController?.abort();
		this.memoryController = null;
		this.memoryBarEl.empty();
		this.memoryBarEl.hide();
	}

	/**
	 * The suggestion strip. Collapsed it is a single line naming the count, so
	 * the chat stays the focus; expanded, each candidate can be kept or skipped
	 * on its own. Nothing is written until something is tapped.
	 */
	private renderMemorySuggestions(candidates: string[]): void {
		const bar = this.memoryBarEl;
		bar.empty();
		bar.show();

		const remaining = new Set(candidates);

		const head = bar.createDiv({ cls: "yaaiop-memory-head" });

		const toggle = head.createEl("button", { cls: "yaaiop-memory-toggle" });
		const chevron = toggle.createSpan({ cls: "yaaiop-memory-chevron" });
		const label = toggle.createSpan({ cls: "yaaiop-memory-label" });

		const dismiss = head.createEl("button", {
			cls: "yaaiop-memory-dismiss",
			attr: { "aria-label": "Dismiss suggestions" },
		});
		setIcon(dismiss, "x");
		dismiss.onclick = () => this.clearMemorySuggestions();

		const body = bar.createDiv({ cls: "yaaiop-memory-body" });

		const applyCollapsed = () => {
			setIcon(chevron, this.memoryCollapsed ? "chevron-right" : "chevron-down");
			label.setText(
				this.memoryCollapsed
					? `Add to memory? (${remaining.size})`
					: "Add to memory?",
			);
			toggle.setAttribute("aria-expanded", String(!this.memoryCollapsed));
			body.toggleClass("yaaiop-memory-body-hidden", this.memoryCollapsed);
		};

		toggle.onclick = () => {
			this.memoryCollapsed = !this.memoryCollapsed;
			applyCollapsed();
		};

		const drop = (text: string, row: HTMLElement) => {
			remaining.delete(text);
			row.remove();
			if (remaining.size === 0) this.clearMemorySuggestions();
			else applyCollapsed();
		};

		for (const text of candidates) {
			const row = body.createDiv({ cls: "yaaiop-memory-suggestion" });

			const add = row.createEl("button", {
				cls: "yaaiop-memory-add",
				attr: { "aria-label": `Remember: ${text}` },
			});
			const icon = add.createSpan({ cls: "yaaiop-memory-add-icon" });
			setIcon(icon, "plus");
			add.createSpan({ cls: "yaaiop-memory-add-text", text });
			add.onclick = () => void this.keepMemory(text, () => drop(text, row));

			const skip = row.createEl("button", {
				cls: "yaaiop-memory-skip",
				attr: { "aria-label": "Skip this one" },
			});
			setIcon(skip, "x");
			skip.onclick = () => drop(text, row);
		}

		applyCollapsed();
	}

	private async keepMemory(text: string, onKept: () => void): Promise<void> {
		const settings = this.plugin.settings;
		if (settings.memories.length >= MAX_MEMORIES) {
			new Notice(`YAAIOP: memory is full (${MAX_MEMORIES}). Delete some in settings.`);
			return;
		}
		settings.memories.push(newMemory(text));
		await this.plugin.saveSettings();
		onKept();
	}

	private addUserMessage(text: string): void {
		const el = this.messagesEl.createDiv({ cls: "yaaiop-msg yaaiop-msg-user" });
		el.createDiv({ cls: "yaaiop-bubble", text });
		this.scrollToBottom();
	}

	private addAssistantMessage() {
		const el = this.messagesEl.createDiv({ cls: "yaaiop-msg yaaiop-msg-assistant" });

		let thinkingEl: HTMLDetailsElement | null = null;
		let thinkingBody: HTMLElement | null = null;
		let toolsEl: HTMLElement | null = null;

		const body = el.createDiv({ cls: "yaaiop-bubble" });
		// While streaming we write plain text (cheap). Markdown is rendered once
		// at the end — re-rendering the whole message per token is not viable,
		// especially on a phone.
		const streamEl = body.createDiv({ cls: "yaaiop-streaming" });

		// Arrow functions below close over `this` lexically, so the returned
		// handle needs no alias.
		return {
			setThinking: (text: string) => {
				if (!thinkingEl) {
					thinkingEl = el.createEl("details", { cls: "yaaiop-thinking" });
					thinkingEl.createEl("summary", { text: "Thinking" });
					thinkingBody = thinkingEl.createDiv({ cls: "yaaiop-thinking-body" });
					el.insertBefore(thinkingEl, body);
				}
				thinkingBody!.setText(text);
				this.scrollToBottom();
			},

			addToolCall: (summary: ToolCallSummary) => {
				if (!toolsEl) {
					toolsEl = el.createDiv({ cls: "yaaiop-tools" });
					el.insertBefore(toolsEl, body);
				}
				const row = toolsEl.createDiv({ cls: "yaaiop-tool" });
				const icon = row.createSpan({ cls: "yaaiop-tool-icon" });
				setIcon(icon, TOOL_ICONS[summary.name] ?? "wrench");
				row.createSpan({ cls: "yaaiop-tool-name", text: summary.name });
				row.createSpan({ cls: "yaaiop-tool-detail", text: summary.detail });
				this.scrollToBottom();
			},

			setStreamingText: (text: string) => {
				streamEl.setText(text);
				this.scrollToBottom();
			},

			finalize: async (text: string) => {
				streamEl.remove();
				if (!text.trim()) return;
				const rendered = body.createDiv({ cls: "yaaiop-markdown" });
				await MarkdownRenderer.render(this.app, text, rendered, "/", this);
				this.scrollToBottom();
			},

			addNotice: (text: string) => {
				el.createDiv({ cls: "yaaiop-notice", text });
			},

			addError: (text: string) => {
				el.createDiv({ cls: "yaaiop-error", text: `Error: ${text}` });
			},
		};
	}

	private scrollToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}
}

/**
 * One-line description of a persisted tool call. The live view shows a richer
 * summary built from the tool's own result; a reopened chat only has the input.
 */
function summariseInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const values = Object.entries(input as Record<string, unknown>)
		.filter(([, v]) => v !== undefined && v !== null && v !== "")
		.map(([k, v]) => `${k}: ${String(v)}`);
	const joined = values.join(", ");
	return joined.length > 80 ? `${joined.slice(0, 80)}…` : joined;
}

const TOOL_ICONS: Record<string, string> = {
	search_vault: "search",
	read_note: "file-text",
	list_notes: "list",
	recent_notes: "clock",
	note_links: "link",
};
