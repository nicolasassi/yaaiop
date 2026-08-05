import { App, TFile } from "obsidian";
import { VaultSearch, attachmentContext, referencingNotes, resolveFile } from "./search";
import { classifyFile, describeKind, isReadableAsText, loadMedia, type FileKind } from "./files";
import type { YaaiopSettings } from "./settings";
import type { MediaAttachment, MediaCapabilities, ToolDefinition } from "./providers";

export { resolveFile };

const KIND_VALUES = ["all", "notes", "images", "pdfs", "text", "other"] as const;
type KindFilter = (typeof KIND_VALUES)[number];

/**
 * Every tool here is read-only by construction: nothing in this file calls
 * vault.create/modify/delete/rename. Write support is a deliberate later step.
 */
export const VAULT_TOOLS: ToolDefinition[] = [
	{
		name: "search_vault",
		description:
			"Search the vault for files relevant to a query. Covers notes, text files, and attachments (images, PDFs). Uses semantic (meaning-based) search when available, otherwise keyword search. Attachments are matched on their filename and on the text of notes that embed them, since an image's own filename is often meaningless. Returns paths with a short snippet and a file kind — call read_file to get full contents.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "What to look for, phrased as a sentence or topic description.",
				},
				limit: {
					type: "integer",
					description: "Maximum files to return. Defaults to the user's configured limit.",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "read_file",
		description:
			"Read one file by its vault path. Notes and text files come back as text. Images and PDFs are attached directly so you can look at them, along with the text of any notes that embed them. Other binary types return metadata and context only.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault-relative path to the file." },
			},
			required: ["path"],
		},
	},
	{
		name: "list_files",
		description:
			"List file paths in the vault, optionally filtered by folder, filename substring, or kind. Use this to discover how the vault is organised — including which images or PDFs exist in a folder — before reading.",
		parameters: {
			type: "object",
			properties: {
				folder: {
					type: "string",
					description:
						"Only return files whose path starts with this folder. Use a top-level folder name from the vault overview, or a nested path like 'Parent/Child'.",
				},
				name_contains: {
					type: "string",
					description: "Only return files whose filename contains this substring.",
				},
				kind: {
					type: "string",
					enum: [...KIND_VALUES],
					description: "Restrict to a file kind. Defaults to 'notes'.",
				},
				limit: { type: "integer", description: "Maximum paths to return (default 100)." },
			},
			required: [],
		},
	},
	{
		name: "recent_files",
		description:
			"List the most recently modified files, newest first, with their modification dates. Useful for questions about what the user has been working on, or which photos and documents they added recently.",
		parameters: {
			type: "object",
			properties: {
				limit: { type: "integer", description: "How many files to return (default 20)." },
				within_days: {
					type: "integer",
					description: "Only include files modified within this many days.",
				},
				kind: {
					type: "string",
					enum: [...KIND_VALUES],
					description: "Restrict to a file kind. Defaults to 'notes'.",
				},
			},
			required: [],
		},
	},
	{
		name: "file_links",
		description:
			"Show how a file connects to the rest of the vault: its outgoing links, and the notes that link to or embed it together with the text surrounding each reference. For an image or PDF this is the main way to learn what it actually is.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault-relative path to the file." },
			},
			required: ["path"],
		},
	},
];

export interface ToolCallSummary {
	name: string;
	detail: string;
}

export interface ToolOutcome {
	content: string;
	isError: boolean;
	summary: ToolCallSummary;
	/** Attachments to hand to the model alongside the text. */
	media?: MediaAttachment[];
}

export class VaultToolRunner {
	constructor(
		private app: App,
		private search: VaultSearch,
		private getSettings: () => YaaiopSettings,
		private getCapabilities: () => MediaCapabilities,
	) {}

	/**
	 * Executes one tool call. Errors are returned as text rather than thrown:
	 * the model recovers far better from "no file at that path" than from a
	 * dropped turn, and the caller marks the result with is_error.
	 */
	async run(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
		try {
			switch (name) {
				case "search_vault":
					return await this.searchVault(input);
				// The pre-attachment tool names are accepted too, so continuing a
				// reopened conversation that used them still works.
				case "read_file":
				case "read_note":
					return await this.readFile(input);
				case "list_files":
				case "list_notes":
					return this.listFiles(input);
				case "recent_files":
				case "recent_notes":
					return this.recentFiles(input);
				case "file_links":
				case "note_links":
					return await this.fileLinks(input);
				default:
					return {
						content: `Unknown tool: ${name}`,
						isError: true,
						summary: { name, detail: "unknown tool" },
					};
			}
		} catch (err) {
			return {
				content: `Tool failed: ${(err as Error).message}`,
				isError: true,
				summary: { name, detail: "failed" },
			};
		}
	}

	private async searchVault(input: Record<string, unknown>): Promise<ToolOutcome> {
		const settings = this.getSettings();
		const query = String(input.query ?? "").trim();
		if (!query) {
			return {
				content: "No query provided.",
				isError: true,
				summary: { name: "search_vault", detail: "empty query" },
			};
		}

		const limit = clampInt(input.limit, settings.searchLimit, 1, 20);
		const { hits, method } = await this.search.search(
			query,
			limit,
			settings.preferSmartConnections,
			settings.includeAttachments,
		);

		const summary: ToolCallSummary = {
			name: "search_vault",
			detail: `"${query}" — ${hits.length} result${hits.length === 1 ? "" : "s"} (${
				method === "smart-connections" ? "semantic" : "keyword"
			})`,
		};

		if (hits.length === 0) {
			return {
				content: `No files matched "${query}" (${method} search).`,
				isError: false,
				summary,
			};
		}

		const body = hits
			.map((h, i) => `${i + 1}. [${describeKind(h.kind)}] ${h.path}\n   ${h.snippet}`)
			.join("\n\n");
		return {
			content: `${method === "smart-connections" ? "Semantic" : "Keyword"} search for "${query}":\n\n${body}`,
			isError: false,
			summary,
		};
	}

	private async readFile(input: Record<string, unknown>): Promise<ToolOutcome> {
		const rawPath = String(input.path ?? "");
		const file = resolveFile(this.app, rawPath);
		if (!file) {
			return {
				content: `No file found at "${rawPath}". Use list_files or search_vault to find the correct path.`,
				isError: true,
				summary: { name: "read_file", detail: `${rawPath} (not found)` },
			};
		}

		const settings = this.getSettings();
		const kind = classifyFile(file);

		if (isReadableAsText(kind)) {
			let content = await this.app.vault.cachedRead(file);
			let truncated = false;
			if (content.length > settings.maxNoteChars) {
				content = content.slice(0, settings.maxNoteChars);
				truncated = true;
			}
			const header = `# ${file.path}\n(${describeKind(kind)}, modified ${formatDate(file.stat.mtime)})\n\n`;
			const footer = truncated
				? `\n\n[Truncated at ${settings.maxNoteChars} characters of ${file.stat.size} bytes.]`
				: "";
			return {
				content: header + content + footer,
				isError: false,
				summary: { name: "read_file", detail: file.path },
			};
		}

		// Attachments: send the bytes when the model can use them, and always
		// include surrounding note text — often the only thing that says what the
		// file is for.
		const context = await attachmentContext(this.app, file);
		const contextText = context.excerpts.length
			? `\n\nReferenced in:\n${context.excerpts.map((e) => `- ${e}`).join("\n")}`
			: "\n\nNo notes reference this file.";

		if (kind === "other") {
			return {
				content: `${file.path} is a ${file.extension.toUpperCase()} file (${formatBytes(file.stat.size)}), which cannot be read directly.${contextText}`,
				isError: false,
				summary: { name: "read_file", detail: `${file.path} (metadata only)` },
			};
		}

		const loaded = await loadMedia(this.app, file, kind, {
			maxBytes: settings.maxAttachmentMB * 1024 * 1024,
			maxImageEdge: settings.maxImageEdge,
			capabilities: this.getCapabilities(),
		});

		const header = `${file.path} — ${describeKind(kind)}, ${formatBytes(file.stat.size)}, modified ${formatDate(file.stat.mtime)}\n${loaded.note}`;
		return {
			content: header + contextText,
			isError: false,
			media: loaded.attachment ? [loaded.attachment] : undefined,
			summary: {
				name: "read_file",
				detail: loaded.attachment
					? `${file.path} (${describeKind(kind)} attached)`
					: `${file.path} (context only)`,
			},
		};
	}

	private listFiles(input: Record<string, unknown>): ToolOutcome {
		const folder = String(input.folder ?? "").trim().replace(/^\/+|\/+$/g, "");
		const nameContains = String(input.name_contains ?? "").trim().toLowerCase();
		const kind = parseKind(input.kind);
		const limit = clampInt(input.limit, 100, 1, 500);

		let files = this.filesOfKind(kind);
		if (folder) files = files.filter((f) => f.path.startsWith(`${folder}/`) || f.path === folder);
		if (nameContains) {
			files = files.filter((f) => f.basename.toLowerCase().includes(nameContains));
		}

		const total = files.length;
		files.sort((a, b) => a.path.localeCompare(b.path));
		const shown = files.slice(0, limit);

		const filter = [
			folder && `folder "${folder}"`,
			nameContains && `name contains "${nameContains}"`,
			`kind: ${kind}`,
		]
			.filter(Boolean)
			.join(", ");

		if (total === 0) {
			return {
				content: `No files matched (${filter}).`,
				isError: false,
				summary: { name: "list_files", detail: filter },
			};
		}

		const body = shown.map((f) => f.path).join("\n");
		const note = total > shown.length ? `\n\n[Showing ${shown.length} of ${total}.]` : "";
		return {
			content: `${total} file${total === 1 ? "" : "s"} (${filter}):\n\n${body}${note}`,
			isError: false,
			summary: { name: "list_files", detail: `${filter} — ${total} found` },
		};
	}

	private recentFiles(input: Record<string, unknown>): ToolOutcome {
		const limit = clampInt(input.limit, 20, 1, 100);
		const withinDays = clampInt(input.within_days, 0, 0, 3650);
		const kind = parseKind(input.kind);
		const cutoff = withinDays > 0 ? Date.now() - withinDays * 86_400_000 : 0;

		const files = this.filesOfKind(kind)
			.filter((f) => f.stat.mtime >= cutoff)
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, limit);

		if (files.length === 0) {
			return {
				content:
					withinDays > 0
						? `No ${kind} modified in the last ${withinDays} days.`
						: `No ${kind} found.`,
				isError: false,
				summary: { name: "recent_files", detail: "none" },
			};
		}

		const body = files
			.map((f) => `${formatDate(f.stat.mtime)}  [${describeKind(classifyFile(f))}] ${f.path}`)
			.join("\n");
		return {
			content: `Recently modified (${kind}):\n\n${body}`,
			isError: false,
			summary: { name: "recent_files", detail: `${files.length} file(s), kind: ${kind}` },
		};
	}

	private async fileLinks(input: Record<string, unknown>): Promise<ToolOutcome> {
		const rawPath = String(input.path ?? "");
		const file = resolveFile(this.app, rawPath);
		if (!file) {
			return {
				content: `No file found at "${rawPath}".`,
				isError: true,
				summary: { name: "file_links", detail: `${rawPath} (not found)` },
			};
		}

		// resolvedLinks is a public, typed map of source -> { target: count },
		// and covers embeds as well as plain links.
		const outgoing = Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {});
		const incoming = referencingNotes(this.app, file.path);
		const context = await attachmentContext(this.app, file);

		const sections = [
			`Links for ${file.path} (${describeKind(classifyFile(file))})`,
			"",
			`Outgoing (${outgoing.length}):`,
			outgoing.length ? outgoing.map((p) => `- ${p}`).join("\n") : "- none",
			"",
			`Referenced by (${incoming.length}):`,
			incoming.length ? incoming.map((p) => `- ${p}`).join("\n") : "- none",
		];

		if (context.excerpts.length) {
			sections.push("", "Surrounding text:", ...context.excerpts.map((e) => `- ${e}`));
		}

		return {
			content: sections.join("\n"),
			isError: false,
			summary: {
				name: "file_links",
				detail: `${file.basename} — ${outgoing.length} out, ${incoming.length} in`,
			},
		};
	}

	private filesOfKind(kind: KindFilter): TFile[] {
		const all = this.app.vault.getFiles();
		if (kind === "all") return all;
		return all.filter((f) => {
			const fileKind = classifyFile(f);
			switch (kind) {
				case "notes":
					return fileKind === "note";
				case "images":
					return fileKind === "image";
				case "pdfs":
					return fileKind === "pdf";
				case "text":
					return fileKind === "text";
				case "other":
					return fileKind === "other";
			}
		});
	}
}

function parseKind(value: unknown): KindFilter {
	const raw = String(value ?? "").trim().toLowerCase();
	return (KIND_VALUES as readonly string[]).includes(raw) ? (raw as KindFilter) : "notes";
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Local-time "YYYY-MM-DD HH:mm". Avoids a moment dependency. */
export function formatDate(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Local-time "Monday, 2026-08-02" for the system prompt. */
export function formatToday(now = new Date()): string {
	return `${WEEKDAYS[now.getDay()]}, ${formatDate(now.getTime()).split(" ")[0]}`;
}

/**
 * Reads the note the user pointed at for standing instructions — CLAUDE.md by
 * default, but nothing here cares about the name.
 * Returns null when the toggle is off, the path is blank, or no such note exists.
 */
export async function loadInstructionsFile(
	app: App,
	path: string,
	maxChars: number,
): Promise<{ path: string; content: string; truncated: boolean } | null> {
	const trimmed = path.trim();
	if (!trimmed) return null;

	const file = resolveFile(app, trimmed);
	if (!file) return null;

	try {
		let content = await app.vault.cachedRead(file);
		const truncated = content.length > maxChars;
		if (truncated) content = content.slice(0, maxChars);
		if (!content.trim()) return null;
		return { path: file.path, content, truncated };
	} catch {
		return null;
	}
}

/** Whether a note exists at the configured path — used to label the setting. */
export function instructionsFileExists(app: App, path: string): boolean {
	const trimmed = path.trim();
	return trimmed ? resolveFile(app, trimmed) !== null : false;
}

/**
 * A one-line description of the vault for the system prompt: how many notes and
 * attachments there are, and which folders hold them.
 */
export function vaultOverview(app: App): string {
	const files = app.vault.getFiles();
	const counts: Record<FileKind, number> = { note: 0, text: 0, image: 0, pdf: 0, other: 0 };
	const folders = new Map<string, number>();

	for (const f of files) {
		counts[classifyFile(f)] += 1;
		const top = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
		folders.set(top, (folders.get(top) ?? 0) + 1);
	}

	const listed = [...folders.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15)
		.map(([name, count]) => `${name} (${count})`)
		.join(", ");

	const kinds = [
		`${counts.note} notes`,
		counts.image ? `${counts.image} images` : "",
		counts.pdf ? `${counts.pdf} PDFs` : "",
		counts.text ? `${counts.text} text files` : "",
		counts.other ? `${counts.other} other files` : "",
	]
		.filter(Boolean)
		.join(", ");

	return `${kinds}. Top-level folders: ${listed}.`;
}

/**
 * The top-level folder holding the most notes, or null for a flat vault.
 * Used to make UI examples fit whatever vault the plugin is installed in,
 * rather than hardcoding folder names.
 */
export function largestFolder(app: App): string | null {
	const counts = new Map<string, number>();
	for (const f of app.vault.getMarkdownFiles()) {
		if (!f.path.includes("/")) continue;
		const top = f.path.split("/")[0];
		counts.set(top, (counts.get(top) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestCount = 0;
	for (const [name, count] of counts) {
		if (count > bestCount) {
			best = name;
			bestCount = count;
		}
	}
	return best;
}
