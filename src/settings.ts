import {
	App,
	Notice,
	PluginSettingTab,
	type Setting,
	type SettingDefinitionItem,
	type SettingDefinitionList,
	type SettingGroupItem,
} from "obsidian";
import type YaaiopPlugin from "./main";
import { instructionsFileExists } from "./vault-tools";
import { newSessionId } from "./store";
import { MAX_MEMORIES, type Memory } from "./memory";
import {
	DEFAULT_PROVIDER_ID,
	PROVIDERS,
	REASONING_EFFORTS,
	modelInfo,
	providerInfo,
	type ModelInfo,
	type ProviderInfo,
	type ReasoningEffort,
} from "./providers";

/** A reusable opening message the user can fire off when starting a chat. */
export interface SavedPrompt {
	id: string;
	name: string;
	prompt: string;
}

export interface YaaiopSettings {
	providerId: string;
	model: string;
	effort: ReasoningEffort;
	maxTokens: number;
	showThinking: boolean;
	/** How many notes a single search_vault call may return. */
	searchLimit: number;
	/** Characters of a note body handed to the model before truncation. */
	maxNoteChars: number;
	preferSmartConnections: boolean;
	/** Whether search and listings surface non-markdown files at all. */
	includeAttachments: boolean;
	/** Images/PDFs larger than this are described rather than sent. */
	maxAttachmentMB: number;
	/** Images are downscaled so their long edge fits this, to control cost. */
	maxImageEdge: number;
	extraInstructions: string;
	/** When off, the instructions file is never read, whatever the path says. */
	useInstructionsFile: boolean;
	/** Vault-relative path to a note of standing instructions, e.g. CLAUDE.md. */
	instructionsPath: string;
	maxInstructionsChars: number;
	savedPrompts: SavedPrompt[];
	persistSessions: boolean;
	maxStoredSessions: number;
	/** When off, nothing is suggested and kept memories are not sent. */
	memoryEnabled: boolean;
	/** Kept memories, in the order they were added. Injected on every message. */
	memories: Memory[];
}

export const DEFAULT_SETTINGS: YaaiopSettings = {
	providerId: DEFAULT_PROVIDER_ID,
	model: providerInfo(DEFAULT_PROVIDER_ID).defaultModel,
	effort: "medium",
	maxTokens: 64000,
	showThinking: true,
	searchLimit: 8,
	maxNoteChars: 12000,
	preferSmartConnections: true,
	includeAttachments: true,
	maxAttachmentMB: 8,
	maxImageEdge: 1568,
	extraInstructions: "",
	useInstructionsFile: true,
	// CLAUDE.md by default because it is the file most vaults already have. The
	// plugin has no stake in the name — AGENTS.md or anything else works.
	instructionsPath: "CLAUDE.md",
	maxInstructionsChars: 10000,
	savedPrompts: [],
	persistSessions: true,
	maxStoredSessions: 25,
	// Off by default: it spends tokens the user did not ask to spend, on every
	// message, and a feature that quietly costs money should be opted into.
	memoryEnabled: false,
	memories: [],
};

/**
 * Settings written before the instructions file was renamed.
 *
 * It was called "CLAUDE.md" throughout when Anthropic was the only backend, but
 * the feature only ever read whatever path it was given — nothing about it is
 * provider-specific. The keys were renamed to say so; these are carried over so
 * upgrading does not silently reset a customised path back to the default.
 */
interface LegacySettings {
	useClaudeMd?: boolean;
	claudeMdPath?: string;
	maxClaudeMdChars?: number;
}

export function migrateSettings(
	stored: Partial<YaaiopSettings> & LegacySettings,
): Partial<YaaiopSettings> {
	const { useClaudeMd, claudeMdPath, maxClaudeMdChars, ...current } = stored;
	const migrated: Partial<YaaiopSettings> = { ...current };

	// The new key wins where both exist; the old ones then drop out on next save.
	if (migrated.useInstructionsFile === undefined && useClaudeMd !== undefined) {
		migrated.useInstructionsFile = useClaudeMd;
	}
	if (migrated.instructionsPath === undefined && claudeMdPath !== undefined) {
		migrated.instructionsPath = claudeMdPath;
	}
	if (migrated.maxInstructionsChars === undefined && maxClaudeMdChars !== undefined) {
		migrated.maxInstructionsChars = maxClaudeMdChars;
	}

	return migrated;
}

/**
 * API keys deliberately do NOT live in the plugin's data.json.
 *
 * data.json sits inside the vault at .obsidian/plugins/<id>/data.json, so it
 * would be picked up by Obsidian Sync and by any third-party sync or git
 * plugin — i.e. the key could end up in a commit history or a bucket. Obsidian's
 * local storage is scoped per device and per vault and never syncs, so the key
 * stays on the machine that typed it. The trade-off is that you enter it once
 * per device.
 *
 * Keys are stored per provider so switching backends does not lose the other's.
 */
function apiKeyStorageKey(providerId: string): string {
	return `yaaiop:api-key:${providerId}`;
}

export function loadApiKey(app: App, providerId: string): string {
	try {
		const stored: unknown = app.loadLocalStorage(apiKeyStorageKey(providerId));
		return typeof stored === "string" ? stored : "";
	} catch {
		return "";
	}
}

export function saveApiKey(app: App, providerId: string, key: string): void {
	const trimmed = key.trim();
	app.saveLocalStorage(apiKeyStorageKey(providerId), trimmed.length > 0 ? trimmed : null);
}

/**
 * Keys addressing one field of one list entry, e.g. `prompt:<id>:name`.
 *
 * The declarative settings API addresses every control by a single string key
 * that `getControlValue`/`setControlValue` resolve. Plain settings use their
 * own property name; entries of the saved-prompt and memory lists need the
 * entry's identity as well, so they get a scoped key instead.
 */
function scopedKey(kind: "prompt" | "memory", id: string, field: string): string {
	return `${kind}:${id}:${field}`;
}

function parseScopedKey(
	key: string,
): { kind: string; id: string; field: string } | null {
	const parts = key.split(":");
	return parts.length === 3
		? { kind: parts[0], id: parts[1], field: parts[2] }
		: null;
}

/** First line of a prompt, for the collapsed row of the saved-prompt list. */
function summarise(text: string, max = 60): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export class YaaiopSettingTab extends PluginSettingTab {
	plugin: YaaiopPlugin;

	constructor(app: App, plugin: YaaiopPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * The whole tab, declared rather than rendered.
	 *
	 * Obsidian builds the UI from this and indexes it for settings search, which
	 * an imperative `display()` cannot be. It is called on every render, so
	 * anything derived from current state (descriptions that report what was
	 * detected, the list of saved prompts) is recomputed here; `update()` asks
	 * for a rebuild, `refreshDomState()` only re-evaluates `visible`/`disabled`.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.providerGroup(),
			this.modelGroup(),
			this.vaultAccessGroup(),
			this.instructionsGroup(),
			this.savedPromptsList(),
			this.memoryGroup(),
			this.keptMemoriesList(),
			this.historyGroup(),
			{
				name: "Read-only by design",
				desc: "This plugin can search and read notes, but never creates, edits, or deletes them.",
				aliases: ["write", "safety", "permissions"],
			},
		];
	}

	private get provider(): ProviderInfo {
		return providerInfo(this.plugin.settings.providerId);
	}

	private get model(): ModelInfo {
		return modelInfo(this.provider, this.plugin.settings.model);
	}

	private providerGroup(): SettingDefinitionItem {
		const provider = this.provider;
		const items: SettingGroupItem[] = [];

		if (PROVIDERS.length > 1) {
			items.push({
				name: "AI provider",
				desc: "Which backend answers your questions.",
				control: {
					type: "dropdown",
					key: "providerId",
					options: Object.fromEntries(PROVIDERS.map((p) => [p.info.id, p.info.name])),
				},
			});
		} else {
			items.push({
				name: "AI provider",
				desc: `${provider.name}. More providers are on the roadmap.`,
			});
		}

		items.push(
			{
				name: "API key",
				desc: `Stored in this device's local storage, not in the vault — never synced or committed. Get one at ${provider.apiKeyUrl}`,
				aliases: ["token", "credentials", provider.name],
				// Rendered by hand rather than declared as a text control: the key
				// belongs in a password field, and it is stored per device outside
				// the settings object the declarative controls read and write.
				render: (setting: Setting) => {
					setting.addText((text) => {
						text.inputEl.type = "password";
						text.inputEl.autocapitalize = "off";
						text.inputEl.spellcheck = false;
						text
							.setPlaceholder(provider.apiKeyPlaceholder)
							.setValue(loadApiKey(this.app, provider.id))
							.onChange((value) => {
								saveApiKey(this.app, provider.id, value);
								this.plugin.resetProvider();
							});
					});
				},
			},
			{
				name: "Test connection",
				desc: "Sends a one-token request to confirm the key and model work.",
				render: (setting: Setting) => {
					setting.addButton((btn) =>
						btn.setButtonText("Test").onClick(async () => {
							btn.setDisabled(true).setButtonText("Testing…");
							try {
								await this.plugin.testConnection();
								new Notice("YAAIOP: connection OK");
							} catch (err) {
								new Notice(`YAAIOP: ${(err as Error).message}`, 8000);
							} finally {
								btn.setDisabled(false).setButtonText("Test");
							}
						}),
					);
				},
			},
		);

		return { type: "group", heading: "Provider", items };
	}

	private modelGroup(): SettingDefinitionItem {
		const provider = this.provider;
		const reasoning = () => this.model.supportsReasoning;

		return {
			type: "group",
			heading: "Model",
			items: [
				{
					name: "Model",
					desc: `Models offered by ${provider.name}.`,
					control: {
						type: "dropdown",
						key: "model",
						options: Object.fromEntries(provider.models.map((m) => [m.id, m.label])),
					},
				},
				{
					name: "Reasoning effort",
					desc: "How much the model thinks before answering. Lower is faster and cheaper; higher is better on multi-step questions about your notes.",
					visible: reasoning,
					control: {
						type: "dropdown",
						key: "effort",
						options: Object.fromEntries(REASONING_EFFORTS.map((e) => [e, e])),
					},
				},
				{
					name: "Show reasoning",
					desc: "Display a summary of the model's reasoning above each answer.",
					visible: reasoning,
					control: { type: "toggle", key: "showThinking" },
				},
				{
					name: "Max response tokens",
					desc: "Hard ceiling per reply. Covers reasoning and answer together.",
					control: { type: "number", key: "maxTokens", min: 1, step: 1 },
				},
			],
		};
	}

	private vaultAccessGroup(): SettingDefinitionItem {
		const model = this.model;
		const attachments = () => this.plugin.settings.includeAttachments;

		return {
			type: "group",
			heading: "Vault access",
			items: [
				{
					name: "Use Smart Connections",
					desc: this.plugin.search.smartConnectionsAvailable()
						? "Detected. Searches use semantic (vector) similarity."
						: "Not detected — falling back to keyword search over note titles and bodies.",
					aliases: ["semantic", "embeddings", "vector"],
					control: { type: "toggle", key: "preferSmartConnections" },
				},
				{
					name: "Search results per query",
					desc: "How many notes one search returns. Higher costs more tokens.",
					control: { type: "slider", key: "searchLimit", min: 3, max: 20, step: 1 },
				},
				{
					name: "Max characters per note",
					desc: "Longer notes are truncated before being sent to the model.",
					control: { type: "number", key: "maxNoteChars", min: 500, step: 500 },
				},
				{
					name: "Include attachments",
					desc:
						model.supportsImages || model.supportsDocuments
							? "Let search and listings surface images, PDFs, and other files — not just notes. The model can open images and PDFs it finds."
							: `Search can surface attachments, but ${model.label} cannot open images or PDFs; they will come back as context only.`,
					aliases: ["images", "pdf", "files"],
					control: { type: "toggle", key: "includeAttachments" },
				},
				{
					name: "Max attachment size (MB)",
					desc: "Bigger images and PDFs are described instead of sent.",
					visible: attachments,
					control: { type: "number", key: "maxAttachmentMB", min: 0.1, step: "any" },
				},
				{
					name: "Max image edge (px)",
					desc: "Images are downscaled so their long edge fits this before being sent. Lower is cheaper and faster; higher preserves fine detail like handwriting.",
					visible: attachments,
					control: {
						type: "slider",
						key: "maxImageEdge",
						min: 512,
						max: 2576,
						step: 128,
						displayFormat: (value) => `${value} px`,
					},
				},
			],
		};
	}

	private instructionsGroup(): SettingDefinitionItem {
		const { useInstructionsFile, instructionsPath } = this.plugin.settings;
		const found = instructionsFileExists(this.app, instructionsPath);

		return {
			type: "group",
			heading: "Instructions",
			// The toggle's description reports whether the file is actually there,
			// so it needs a way to be re-checked after the note is created.
			extraButtons: [
				(btn) =>
					btn
						.setIcon("refresh-cw")
						.setTooltip("Re-check the instructions file path")
						.onClick(() => this.update()),
			],
			items: [
				{
					name: "Use a vault instructions file",
					desc: useInstructionsFile
						? found
							? `Found "${instructionsPath}". Its contents are added to the system prompt on every message.`
							: `No note at "${instructionsPath}" — nothing is added. Create one, or change the path below.`
						: "Off — the instructions file is ignored entirely, even if one exists.",
					aliases: ["CLAUDE.md", "AGENTS.md", "system prompt"],
					control: { type: "toggle", key: "useInstructionsFile" },
				},
				{
					name: "Instructions file path",
					desc: "Vault-relative path to a note describing how you want this vault handled. CLAUDE.md by default because that is what most vaults already have — AGENTS.md or any other note works just as well, whichever provider you use. Blank disables it just like the toggle above.",
					visible: () => this.plugin.settings.useInstructionsFile,
					control: { type: "text", key: "instructionsPath", placeholder: "CLAUDE.md" },
				},
				{
					name: "Extra instructions",
					desc: "Appended to the system prompt. This is the place for anything specific to your vault that the model cannot infer from folder names alone — naming conventions, what a folder is for, tags you rely on, or how you want notes cited.",
					control: {
						type: "textarea",
						key: "extraInstructions",
						rows: 5,
						placeholder: "Anything the model should know about this vault.",
					},
				},
			],
		};
	}

	private savedPromptsList(): SettingDefinitionList {
		const prompts = this.plugin.settings.savedPrompts;

		return {
			type: "list",
			heading: "Saved prompts",
			emptyState:
				"No saved prompts yet. Saved prompts are openers you can start a new chat with, from the chat's blank screen or the \"Start chat from saved prompt\" command.",
			addItem: {
				name: "Add prompt",
				action: () => {
					prompts.push({ id: newSessionId(), name: "New prompt", prompt: "" });
					void this.persist();
				},
			},
			onDelete: (index) => {
				prompts.splice(index, 1);
				void this.persist();
			},
			onReorder: (oldIndex, newIndex) => {
				const [moved] = prompts.splice(oldIndex, 1);
				prompts.splice(newIndex, 0, moved);
				void this.persist();
			},
			items: prompts.map((prompt) => ({
				type: "page" as const,
				name: prompt.name || "Untitled prompt",
				desc: summarise(prompt.prompt),
				items: [
					{
						name: "Name",
						desc: "How it appears in the prompt picker.",
						control: {
							type: "text" as const,
							key: scopedKey("prompt", prompt.id, "name"),
							placeholder: "Weekly review",
						},
					},
					{
						name: "Prompt",
						desc: "Sent as the first message of the chat.",
						control: {
							type: "textarea" as const,
							key: scopedKey("prompt", prompt.id, "prompt"),
							rows: 6,
							placeholder: "What should the assistant do when this prompt is used?",
						},
					},
				],
			})),
		};
	}

	private memoryGroup(): SettingDefinitionItem {
		const { memories } = this.plugin.settings;
		const enabled = () => this.plugin.settings.memoryEnabled;

		return {
			type: "group",
			heading: "Memory",
			items: [
				{
					name: "Remember things between chats",
					desc: "Suggests things worth keeping after each reply. Nothing is kept unless you tap it.",
					control: { type: "toggle", key: "memoryEnabled" },
				},
				{
					// Named plainly rather than hidden behind a word like "may" — the
					// cost is the whole reason this is a setting.
					name: "Costs tokens",
					desc: "Memories are re-sent with every message, and each reply triggers one extra request to a small model.",
					visible: enabled,
					searchable: false,
				},
				{
					name: "Delete all memories",
					desc:
						memories.length >= MAX_MEMORIES
							? `${memories.length} of ${MAX_MEMORIES} kept — full. Delete one to keep anything new.`
							: `${memories.length} of ${MAX_MEMORIES} kept. The model is sent exactly what you see below.`,
					visible: () => this.plugin.settings.memories.length > 0,
					render: (setting: Setting) => {
						setting.addButton((btn) =>
							btn
								.setButtonText("Delete all")
								.setDestructive()
								.onClick(async () => {
									this.plugin.settings.memories = [];
									await this.persist();
									new Notice("YAAIOP: memories deleted.");
								}),
						);
					},
				},
			],
		};
	}

	private keptMemoriesList(): SettingDefinitionList {
		const memories = this.plugin.settings.memories;

		return {
			type: "list",
			heading: "Kept memories",
			// Hidden only when the feature is off and there is nothing to show —
			// memories kept before it was turned off stay editable.
			visible: () =>
				this.plugin.settings.memoryEnabled || this.plugin.settings.memories.length > 0,
			emptyState: "Nothing kept yet. Suggestions appear under the chat.",
			onDelete: (index) => {
				memories.splice(index, 1);
				void this.persist();
			},
			items: memories.map((memory: Memory, index: number) => ({
				name: `Memory ${index + 1}`,
				// The text itself is what the user searches for, not the position.
				aliases: [memory.text],
				control: {
					type: "textarea" as const,
					key: scopedKey("memory", memory.id, "text"),
					rows: 2,
				},
			})),
		};
	}

	private historyGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Chat history",
			items: [
				{
					name: "Save chats",
					desc: "Keeps past conversations so you can reopen them. Saved to sessions.json in this plugin's folder, inside the vault — so they travel with whatever sync the vault uses. Turn off to stop saving; already-saved chats stay until you delete them below.",
					control: { type: "toggle", key: "persistSessions" },
				},
				{
					name: "Chats to keep",
					desc: "Oldest are dropped past this count.",
					visible: () => this.plugin.settings.persistSessions,
					control: { type: "slider", key: "maxStoredSessions", min: 5, max: 100, step: 5 },
				},
				{
					name: "Delete all saved chats",
					desc: "Cannot be undone.",
					render: (setting: Setting) => {
						setting.addButton((btn) =>
							btn
								.setButtonText("Delete all")
								.setDestructive()
								.onClick(async () => {
									await this.plugin.store.clear();
									new Notice("YAAIOP: saved chats deleted.");
								}),
						);
					},
				},
			],
		};
	}

	/** Saves, then rebuilds the tab because the definitions themselves changed. */
	private async persist(): Promise<void> {
		await this.plugin.saveSettings();
		this.update();
	}

	getControlValue(key: string): unknown {
		const scoped = parseScopedKey(key);
		if (scoped) {
			if (scoped.kind === "prompt") {
				const prompt = this.plugin.settings.savedPrompts.find((p) => p.id === scoped.id);
				return scoped.field === "name" ? prompt?.name : prompt?.prompt;
			}
			if (scoped.kind === "memory") {
				return this.plugin.settings.memories.find((m) => m.id === scoped.id)?.text;
			}
			return undefined;
		}
		return this.plugin.settings[key as keyof YaaiopSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const scoped = parseScopedKey(key);
		if (scoped) {
			this.setScopedValue(scoped, String(value));
			// No update() here: these fire while the user is typing, and a rebuild
			// would tear the focused field out from under them.
			await this.plugin.saveSettings();
			return;
		}

		const settings = this.plugin.settings;

		switch (key) {
			case "providerId":
				settings.providerId = String(value);
				// Models are provider-specific; reset to that provider's default.
				settings.model = providerInfo(settings.providerId).defaultModel;
				this.plugin.resetProvider();
				await this.persist();
				return;

			// Rebuilt rather than refreshed: these change other rows' descriptions,
			// not just whether they are shown.
			case "model":
				settings.model = String(value);
				await this.persist();
				return;
			case "preferSmartConnections":
				settings.preferSmartConnections = Boolean(value);
				await this.persist();
				return;
			case "useInstructionsFile":
				settings.useInstructionsFile = Boolean(value);
				await this.persist();
				return;
			case "memoryEnabled":
				settings.memoryEnabled = Boolean(value);
				await this.persist();
				return;

			case "effort":
				settings.effort = value as ReasoningEffort;
				break;
			case "showThinking":
				settings.showThinking = Boolean(value);
				break;
			case "maxTokens":
				settings.maxTokens = Number(value);
				break;
			case "searchLimit":
				settings.searchLimit = Number(value);
				break;
			case "maxNoteChars":
				settings.maxNoteChars = Number(value);
				break;
			case "includeAttachments":
				settings.includeAttachments = Boolean(value);
				break;
			case "maxAttachmentMB":
				settings.maxAttachmentMB = Number(value);
				break;
			case "maxImageEdge":
				settings.maxImageEdge = Number(value);
				break;
			case "instructionsPath":
				settings.instructionsPath = String(value);
				break;
			case "extraInstructions":
				settings.extraInstructions = String(value);
				break;
			case "persistSessions":
				settings.persistSessions = Boolean(value);
				break;
			case "maxStoredSessions":
				settings.maxStoredSessions = Number(value);
				break;
			default:
				return;
		}

		await this.plugin.saveSettings();
		// Cheap: re-evaluates which rows should be visible without a rebuild.
		this.refreshDomState();
	}

	private setScopedValue(
		scoped: { kind: string; id: string; field: string },
		value: string,
	): void {
		if (scoped.kind === "prompt") {
			const prompt = this.plugin.settings.savedPrompts.find((p) => p.id === scoped.id);
			if (!prompt) return;
			if (scoped.field === "name") prompt.name = value;
			else prompt.prompt = value;
			return;
		}
		if (scoped.kind === "memory") {
			const memory = this.plugin.settings.memories.find((m) => m.id === scoped.id);
			if (memory) memory.text = value;
		}
	}
}
