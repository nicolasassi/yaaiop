import { App, FuzzySuggestModal, Modal, Notice, setIcon } from "obsidian";
import type { SavedPrompt } from "./settings";
import { formatRelative, type SessionStore, type StoredSession } from "./store";

/** Pick one of the user's saved prompts to open a chat with. */
export class SavedPromptModal extends FuzzySuggestModal<SavedPrompt> {
	constructor(
		app: App,
		private prompts: SavedPrompt[],
		private onPick: (prompt: SavedPrompt) => void,
	) {
		super(app);
		this.setPlaceholder("Start a chat with…");
	}

	getItems(): SavedPrompt[] {
		return this.prompts.filter((p) => p.prompt.trim().length > 0);
	}

	getItemText(item: SavedPrompt): string {
		// Include the body so fuzzy matching finds a prompt by its content too.
		return `${item.name} ${item.prompt}`;
	}

	onChooseItem(item: SavedPrompt): void {
		this.onPick(item);
	}
}

/**
 * Browse and reopen saved chats. A plain Modal rather than a suggest modal so
 * each row can carry its own delete button.
 */
export class SessionHistoryModal extends Modal {
	constructor(
		app: App,
		private store: SessionStore,
		private onOpenSession: (session: StoredSession) => void,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("Saved chats");
		await this.renderList();
	}

	private async renderList(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaaiop-history");

		const sessions = await this.store.list();
		if (sessions.length === 0) {
			contentEl.createEl("p", {
				text: "No saved chats yet.",
				cls: "yaaiop-settings-note",
			});
			return;
		}

		for (const session of sessions) {
			const row = contentEl.createDiv({ cls: "yaaiop-history-row" });

			const open = row.createEl("button", { cls: "yaaiop-history-open" });
			open.createDiv({ cls: "yaaiop-history-title", text: session.title });
			open.createDiv({
				cls: "yaaiop-history-meta",
				text: `${formatRelative(session.updatedAt)} · ${countTurns(session)} messages`,
			});
			open.onclick = () => {
				this.onOpenSession(session);
				this.close();
			};

			const del = row.createEl("button", {
				cls: "yaaiop-history-delete",
				attr: { "aria-label": `Delete "${session.title}"` },
			});
			setIcon(del, "trash");
			del.onclick = async (evt) => {
				evt.stopPropagation();
				await this.store.delete(session.id);
				new Notice("Chat deleted.");
				await this.renderList();
			};
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Only user/assistant turns count; tool-result turns are plumbing. */
function countTurns(session: StoredSession): number {
	return session.messages.filter((m) => !m.parts.some((p) => p.type === "tool_result")).length;
}
