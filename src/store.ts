import type { App, PluginManifest } from "obsidian";
import type { ChatMessage, TextPart } from "./providers";

export interface StoredSession {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** Which backend produced this chat, so the UI can label a mismatch. */
	providerId: string;
	model: string;
	messages: ChatMessage[];
}

/**
 * Bumped to 2 when messages moved from vendor-shaped blocks to the neutral
 * ChatMessage format. Files from an older version are discarded rather than
 * migrated — they are not readable as neutral parts.
 */
const FILE_VERSION = 2;

interface SessionFile {
	version: number;
	sessions: StoredSession[];
}

/** Stop one runaway conversation from bloating the vault indefinitely. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function newSessionId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Derives a human-readable title from the first thing the user said.
 * Tool results and assistant turns are skipped — they make poor titles.
 */
export function deriveTitle(messages: ChatMessage[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = message.parts
			.filter((p): p is TextPart => p.type === "text")
			.map((p) => p.text)
			.join(" ");
		const trimmed = text.trim().replace(/\s+/g, " ");
		if (!trimmed) continue;
		return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
	}
	return "Untitled chat";
}

/**
 * Saved chats live in the plugin's own folder rather than in data.json, so that
 * settings stay small and history can be dropped independently. This means they
 * sit inside the vault and travel with whatever sync the vault already uses —
 * unlike the API key, which is deliberately device-local.
 */
export class SessionStore {
	private cache: StoredSession[] | null = null;

	constructor(
		private app: App,
		private manifest: PluginManifest,
	) {}

	private get path(): string | null {
		return this.manifest.dir ? `${this.manifest.dir}/sessions.json` : null;
	}

	async list(): Promise<StoredSession[]> {
		if (this.cache) return this.cache;

		const path = this.path;
		if (!path) return [];

		try {
			if (!(await this.app.vault.adapter.exists(path))) {
				this.cache = [];
				return this.cache;
			}
			const raw = await this.app.vault.adapter.read(path);
			const parsed = JSON.parse(raw) as SessionFile;
			if (parsed.version !== FILE_VERSION) {
				console.warn(
					`[yaaiop] ignoring saved chats written in format v${parsed.version}; expected v${FILE_VERSION}.`,
				);
				this.cache = [];
				return this.cache;
			}
			this.cache = Array.isArray(parsed.sessions) ? parsed.sessions : [];
		} catch (err) {
			// A corrupt history file must not take the chat down with it.
			console.error("[yaaiop] could not read saved chats:", err);
			this.cache = [];
		}
		return this.cache;
	}

	async save(session: StoredSession, maxSessions: number): Promise<void> {
		const sessions = (await this.list()).filter((s) => s.id !== session.id);
		sessions.unshift(session);
		sessions.sort((a, b) => b.updatedAt - a.updatedAt);

		let pruned = sessions.slice(0, Math.max(1, maxSessions));
		// Byte-budget pass: a handful of long tool-heavy chats can outweigh the
		// count limit, so drop oldest until the file is a sane size.
		while (pruned.length > 1 && JSON.stringify(pruned).length > MAX_FILE_BYTES) {
			pruned = pruned.slice(0, -1);
		}

		await this.write(pruned);
	}

	async delete(id: string): Promise<void> {
		const sessions = (await this.list()).filter((s) => s.id !== id);
		await this.write(sessions);
	}

	async clear(): Promise<void> {
		await this.write([]);
	}

	private async write(sessions: StoredSession[]): Promise<void> {
		const path = this.path;
		if (!path) return;
		this.cache = sessions;
		const payload: SessionFile = { version: FILE_VERSION, sessions };
		try {
			await this.app.vault.adapter.write(path, JSON.stringify(payload));
		} catch (err) {
			console.error("[yaaiop] could not write saved chats:", err);
		}
	}
}

export function formatRelative(ms: number): string {
	const diff = Date.now() - ms;
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (diff < minute) return "just now";
	if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
	if (diff < day) return `${Math.floor(diff / hour)}h ago`;
	if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;

	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
