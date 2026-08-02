import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type YaaiopPlugin from "./main";
import { claudeMdExists } from "./vault-tools";
import { newSessionId } from "./store";
import {
	DEFAULT_PROVIDER_ID,
	PROVIDERS,
	REASONING_EFFORTS,
	modelInfo,
	providerInfo,
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
	/** When off, CLAUDE.md is never read, whatever the path says. */
	useClaudeMd: boolean;
	claudeMdPath: string;
	maxClaudeMdChars: number;
	savedPrompts: SavedPrompt[];
	persistSessions: boolean;
	maxStoredSessions: number;
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
	useClaudeMd: true,
	claudeMdPath: "CLAUDE.md",
	maxClaudeMdChars: 10000,
	savedPrompts: [],
	persistSessions: true,
	maxStoredSessions: 25,
};

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

export class YaaiopSettingTab extends PluginSettingTab {
	plugin: YaaiopPlugin;

	constructor(app: App, plugin: YaaiopPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const provider = providerInfo(this.plugin.settings.providerId);

		new Setting(containerEl).setName("Provider").setHeading();

		if (PROVIDERS.length > 1) {
			new Setting(containerEl)
				.setName("AI provider")
				.setDesc("Which backend answers your questions.")
				.addDropdown((dd) => {
					for (const p of PROVIDERS) dd.addOption(p.info.id, p.info.name);
					dd.setValue(provider.id).onChange(async (value) => {
						this.plugin.settings.providerId = value;
						// Models are provider-specific; reset to that provider's default.
						this.plugin.settings.model = providerInfo(value).defaultModel;
						await this.plugin.saveSettings();
						this.plugin.resetProvider();
						this.display();
					});
				});
		} else {
			new Setting(containerEl)
				.setName("AI provider")
				.setDesc(`${provider.name}. More providers are on the roadmap.`);
		}

		new Setting(containerEl)
			.setName("API key")
			.setDesc(
				`Stored in this device's local storage, not in the vault — never synced or committed. Get one at ${provider.apiKeyUrl}`,
			)
			.addText((text) => {
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

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Sends a one-token request to confirm the key and model work.")
			.addButton((btn) =>
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

		new Setting(containerEl).setName("Model").setHeading();

		new Setting(containerEl)
			.setName("Model")
			.setDesc(`Models offered by ${provider.name}.`)
			.addDropdown((dd) => {
				for (const m of provider.models) dd.addOption(m.id, m.label);
				dd.setValue(this.plugin.settings.model).onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (modelInfo(provider, this.plugin.settings.model).supportsReasoning) {
			new Setting(containerEl)
				.setName("Reasoning effort")
				.setDesc(
					"How much the model thinks before answering. Lower is faster and cheaper; higher is better on multi-step questions about your notes.",
				)
				.addDropdown((dd) => {
					for (const e of REASONING_EFFORTS) dd.addOption(e, e);
					dd.setValue(this.plugin.settings.effort).onChange(async (value) => {
						this.plugin.settings.effort = value as ReasoningEffort;
						await this.plugin.saveSettings();
					});
				});

			new Setting(containerEl)
				.setName("Show reasoning")
				.setDesc("Display a summary of the model's reasoning above each answer.")
				.addToggle((t) =>
					t.setValue(this.plugin.settings.showThinking).onChange(async (value) => {
						this.plugin.settings.showThinking = value;
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Max response tokens")
			.setDesc("Hard ceiling per reply. Covers reasoning and answer together.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxTokens))
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n) && n > 0) {
							this.plugin.settings.maxTokens = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl).setName("Vault access").setHeading();

		new Setting(containerEl)
			.setName("Use Smart Connections")
			.setDesc(
				this.plugin.search.smartConnectionsAvailable()
					? "Detected. Searches use semantic (vector) similarity."
					: "Not detected — falling back to keyword search over note titles and bodies.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.preferSmartConnections).onChange(async (value) => {
					this.plugin.settings.preferSmartConnections = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName("Search results per query")
			.setDesc("How many notes one search returns. Higher costs more tokens.")
			.addSlider((s) =>
				s
					.setLimits(3, 20, 1)
					.setValue(this.plugin.settings.searchLimit)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.searchLimit = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Max characters per note")
			.setDesc("Longer notes are truncated before being sent to the model.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxNoteChars))
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n) && n > 500) {
							this.plugin.settings.maxNoteChars = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		const model = modelInfo(provider, this.plugin.settings.model);

		new Setting(containerEl)
			.setName("Include attachments")
			.setDesc(
				model.supportsImages || model.supportsDocuments
					? "Let search and listings surface images, PDFs, and other files — not just notes. The model can open images and PDFs it finds."
					: `Search can surface attachments, but ${model.label} cannot open images or PDFs; they will come back as context only.`,
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.includeAttachments).onChange(async (value) => {
					this.plugin.settings.includeAttachments = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.includeAttachments) {
			new Setting(containerEl)
				.setName("Max attachment size (MB)")
				.setDesc("Bigger images and PDFs are described instead of sent.")
				.addText((text) =>
					text
						.setValue(String(this.plugin.settings.maxAttachmentMB))
						.onChange(async (value) => {
							const n = Number.parseFloat(value);
							if (Number.isFinite(n) && n > 0) {
								this.plugin.settings.maxAttachmentMB = n;
								await this.plugin.saveSettings();
							}
						}),
				);

			new Setting(containerEl)
				.setName("Max image edge (px)")
				.setDesc(
					"Images are downscaled so their long edge fits this before being sent. Lower is cheaper and faster; higher preserves fine detail like handwriting.",
				)
				.addSlider((s) =>
					s
						.setLimits(512, 2576, 128)
						.setValue(this.plugin.settings.maxImageEdge)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.maxImageEdge = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		const claudeMdFound = claudeMdExists(this.app, this.plugin.settings.claudeMdPath);

		new Setting(containerEl)
			.setName("Use CLAUDE.md")
			.setDesc(
				this.plugin.settings.useClaudeMd
					? claudeMdFound
						? `Found "${this.plugin.settings.claudeMdPath}". Its contents are added to the system prompt on every message.`
						: `No note at "${this.plugin.settings.claudeMdPath}" — nothing is added. Create one, or change the path below.`
					: "Off — CLAUDE.md is ignored entirely, even if one exists.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.useClaudeMd).onChange(async (value) => {
					this.plugin.settings.useClaudeMd = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.useClaudeMd) {
			new Setting(containerEl)
				.setName("Instructions file path")
				.setDesc(
					"Vault-relative path. Defaults to CLAUDE.md; point it anywhere. Blank disables it just like the toggle above.",
				)
				.addText((text) =>
					text
						.setPlaceholder("CLAUDE.md")
						.setValue(this.plugin.settings.claudeMdPath)
						.onChange(async (value) => {
							this.plugin.settings.claudeMdPath = value;
							await this.plugin.saveSettings();
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("refresh-cw")
						.setTooltip("Re-check this path")
						.onClick(() => this.display()),
				);
		}

		new Setting(containerEl)
			.setName("Extra instructions")
			.setDesc(
				"Appended to the system prompt. This is the place for anything specific to your vault that the model cannot infer from folder names alone — naming conventions, what a folder is for, tags you rely on, or how you want notes cited.",
			)
			.addTextArea((ta) => {
				ta.inputEl.rows = 5;
				ta.setValue(this.plugin.settings.extraInstructions).onChange(async (value) => {
					this.plugin.settings.extraInstructions = value;
					await this.plugin.saveSettings();
				});
			});

		this.renderSavedPrompts(containerEl);
		this.renderHistorySettings(containerEl);

		containerEl.createEl("p", {
			text: "This plugin is read-only: it can search and read notes, but never creates, edits, or deletes them.",
			cls: "yaaiop-settings-note",
		});
	}

	private renderSavedPrompts(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Saved prompts").setHeading();

		new Setting(containerEl)
			.setDesc(
				"Openers you can start a new chat with, from the chat's blank screen or the \"Start chat from saved prompt\" command.",
			)
			.addButton((btn) =>
				btn
					.setButtonText("Add prompt")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.savedPrompts.push({
							id: newSessionId(),
							name: "New prompt",
							prompt: "",
						});
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.savedPrompts.length === 0) {
			containerEl.createEl("p", {
				text: "No saved prompts yet.",
				cls: "yaaiop-settings-note",
			});
			return;
		}

		for (const [index, prompt] of this.plugin.settings.savedPrompts.entries()) {
			const box = containerEl.createDiv({ cls: "yaaiop-prompt-editor" });

			new Setting(box)
				.setName("Name")
				.addText((text) =>
					text
						.setPlaceholder("Weekly review")
						.setValue(prompt.name)
						.onChange(async (value) => {
							prompt.name = value;
							await this.plugin.saveSettings();
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("arrow-up")
						.setTooltip("Move up")
						.setDisabled(index === 0)
						.onClick(async () => {
							const list = this.plugin.settings.savedPrompts;
							[list[index - 1], list[index]] = [list[index], list[index - 1]];
							await this.plugin.saveSettings();
							this.display();
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete")
						.onClick(async () => {
							this.plugin.settings.savedPrompts.splice(index, 1);
							await this.plugin.saveSettings();
							this.display();
						}),
				);

			new Setting(box).setName("Prompt").addTextArea((ta) => {
				ta.inputEl.rows = 4;
				ta.inputEl.addClass("yaaiop-prompt-textarea");
				ta.setPlaceholder("What should the assistant do when this prompt is used?")
					.setValue(prompt.prompt)
					.onChange(async (value) => {
						prompt.prompt = value;
						await this.plugin.saveSettings();
					});
			});
		}
	}

	private renderHistorySettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Chat history").setHeading();

		new Setting(containerEl)
			.setName("Save chats")
			.setDesc(
				"Keeps past conversations so you can reopen them. Saved to sessions.json in this plugin's folder, inside the vault — so they travel with whatever sync the vault uses. Turn off to stop saving; already-saved chats stay until you delete them below.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.persistSessions).onChange(async (value) => {
					this.plugin.settings.persistSessions = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.persistSessions) {
			new Setting(containerEl)
				.setName("Chats to keep")
				.setDesc("Oldest are dropped past this count.")
				.addSlider((s) =>
					s
						.setLimits(5, 100, 5)
						.setValue(this.plugin.settings.maxStoredSessions)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.maxStoredSessions = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Delete all saved chats")
			.setDesc("Cannot be undone.")
			.addButton((btn) =>
				btn
					.setButtonText("Delete all")
					.setWarning()
					.onClick(async () => {
						await this.plugin.store.clear();
						new Notice("YAAIOP: saved chats deleted.");
					}),
			);
	}
}
