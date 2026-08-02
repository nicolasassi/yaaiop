import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	YaaiopSettingTab,
	loadApiKey,
	type YaaiopSettings,
} from "./settings";
import { VaultSearch } from "./search";
import { VaultToolRunner } from "./vault-tools";
import { ChatSession } from "./agent";
import { SessionStore } from "./store";
import { SavedPromptModal, SessionHistoryModal } from "./modals";
import { YaaiopView, VIEW_TYPE_YAAIOP } from "./view";
import {
	modelInfo,
	providerInfo,
	providerRegistration,
	type ChatProvider,
	type MediaCapabilities,
} from "./providers";

export default class YaaiopPlugin extends Plugin {
	settings!: YaaiopSettings;
	search!: VaultSearch;
	store!: SessionStore;
	private tools!: VaultToolRunner;
	private activeProvider: ChatProvider | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.search = new VaultSearch(this.app);
		this.tools = new VaultToolRunner(
			this.app,
			this.search,
			() => this.settings,
			() => this.mediaCapabilities(),
		);
		this.store = new SessionStore(this.app, this.manifest);

		this.registerView(VIEW_TYPE_YAAIOP, (leaf) => new YaaiopView(leaf, this));

		this.addRibbonIcon("message-circle", "YAAIOP chat", () => void this.activateView());

		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "new-chat",
			name: "New chat",
			callback: () => void this.withView((view) => view.newChat()),
		});

		this.addCommand({
			id: "saved-prompt",
			name: "Start chat from saved prompt",
			callback: () => {
				const prompts = this.settings.savedPrompts.filter((p) => p.prompt.trim());
				if (prompts.length === 0) {
					new Notice("YAAIOP: no saved prompts yet — add some in settings.");
					return;
				}
				new SavedPromptModal(this.app, prompts, (prompt) => {
					void this.withView((view) => view.startWithPrompt(prompt.prompt));
				}).open();
			},
		});

		this.addCommand({
			id: "open-saved-chat",
			name: "Open a saved chat",
			callback: () => {
				new SessionHistoryModal(this.app, this.store, (stored) => {
					void this.withView((view) => view.openSession(stored));
				}).open();
			},
		});

		this.addSettingTab(new YaaiopSettingTab(this.app, this));
	}

	/** Ensures the chat panel exists, then runs an action against it. */
	private async withView(action: (view: YaaiopView) => void): Promise<void> {
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_YAAIOP)[0];
		if (leaf?.view instanceof YaaiopView) action(leaf.view);
	}

	onunload(): void {
		this.activeProvider = null;
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_YAAIOP);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}

		// getRightLeaf gives a sidebar on desktop and a full-screen sheet on
		// mobile, which is the behaviour we want in both cases.
		const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_YAAIOP, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** What the currently selected model can be sent, used to gate attachments. */
	mediaCapabilities(): MediaCapabilities {
		const info = providerInfo(this.settings.providerId);
		const model = modelInfo(info, this.settings.model);
		return { images: model.supportsImages, documents: model.supportsDocuments };
	}

	hasApiKey(): boolean {
		return loadApiKey(this.app, this.settings.providerId).length > 0;
	}

	/** Drops the cached provider so the next call picks up a changed key or backend. */
	resetProvider(): void {
		this.activeProvider = null;
	}

	/** The configured backend, constructed lazily and cached. */
	provider(): ChatProvider {
		if (this.activeProvider) return this.activeProvider;
		const registration = providerRegistration(this.settings.providerId);
		this.activeProvider = registration.create(() =>
			loadApiKey(this.app, registration.info.id),
		);
		return this.activeProvider;
	}

	createSession(): ChatSession {
		return new ChatSession(
			this.app,
			() => this.provider(),
			this.tools,
			() => this.settings,
			() => this.search.smartConnectionsAvailable() && this.settings.preferSmartConnections,
		);
	}

	async testConnection(): Promise<void> {
		await this.provider().testConnection(this.settings.model);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		// Note: API keys are intentionally not part of this object — they live in
		// device-local storage so they never land in a synced/committed data.json.
		await this.saveData(this.settings);
	}
}
