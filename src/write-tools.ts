import { App, TFile, normalizePath } from "obsidian";
import { resolveFile } from "./search";
import {
	hasProposals,
	nextProposalId,
	parseProposals,
	proposeAppend,
	proposeEdits,
	type BuildResult,
	type Edit,
} from "./proposals";
import type { ToolDefinition } from "./providers";
import type { ToolOutcome } from "./vault-tools";

/**
 * Distinct notes one reply may write to. Editing is meant for small updates
 * from what the user just said, not for reorganising the vault; a model that
 * wants a third note is doing something the user should see in chat first.
 */
export const MAX_NOTES_PER_TURN = 2;

const MAX_NEW_NOTE_CHARS = 20000;
const MAX_PROPERTIES = 10;

export const WRITE_TOOLS: ToolDefinition[] = [
	{
		name: "create_note",
		description:
			"Create a new markdown note. Fails if a file already exists at that path — use edit_note or append_to_note for existing notes. Written immediately, with no review step. Missing folders are created. Follow the vault's existing naming and folder conventions.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault-relative path. '.md' is added if missing." },
				content: { type: "string", description: "The full note, including frontmatter if the vault uses it." },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "edit_note",
		description:
			"Propose small edits to an existing note. Nothing changes until the user reviews it: each edit is written into the note as the current lines followed by the proposed lines, and the user accepts, adjusts, or rejects it there. Read the note first — each 'find' must be copied exactly from it and match exactly one place (add surrounding words if needed). The whole lines around each match are shown for review. Not for frontmatter; use set_properties.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault-relative path to the note." },
				edits: {
					type: "array",
					description: "Up to 8 replacements, all in this note.",
					items: {
						type: "object",
						properties: {
							find: { type: "string", description: "Exact text currently in the note." },
							replace: { type: "string", description: "What it should become. Empty to delete it." },
						},
						required: ["find", "replace"],
					},
				},
			},
			required: ["path", "edits"],
		},
	},
	{
		name: "append_to_note",
		description:
			"Propose adding text to an existing note — at the end, or at the end of the section under a heading. Like edit_note, it is written into the note for the user to review, not applied directly. Start the text with a blank line when adding a paragraph after prose; list items can follow a list directly.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault-relative path to the note." },
				text: { type: "string", description: "Markdown to add." },
				under_heading: {
					type: "string",
					description: "Heading text (without #) whose section should receive the text. Omit to add at the end of the note.",
				},
			},
			required: ["path", "text"],
		},
	},
	{
		name: "set_properties",
		description:
			"Set or remove frontmatter properties on an existing note. Applied immediately, with no review step. Use null as a value to remove a property. Returns the previous values — if the user asks to undo, set those back.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault-relative path to the note." },
				properties: {
					type: "object",
					description:
						"Property names mapped to new values: a string, number, boolean, list, or null to remove. Up to 10.",
					additionalProperties: true,
				},
			},
			required: ["path", "properties"],
		},
	},
];

export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

/**
 * Per-reply bookkeeping: which notes have been written, so the cap holds even
 * when the model fires several write calls in parallel.
 */
export class WriteTurn {
	readonly touched = new Set<string>();
	/** Notes that received a proposal this reply and now await review. */
	readonly proposed = new Set<string>();

	claim(path: string): boolean {
		if (this.touched.has(path)) return true;
		if (this.touched.size >= MAX_NOTES_PER_TURN) return false;
		this.touched.add(path);
		return true;
	}
}

export class NoteWriter {
	constructor(private app: App) {}

	async run(name: string, input: Record<string, unknown>, turn: WriteTurn): Promise<ToolOutcome> {
		switch (name) {
			case "create_note":
				return this.createNote(input, turn);
			case "edit_note":
				return this.propose(name, input, turn, (text, firstId) =>
					proposeEdits(text, parseEdits(input.edits), firstId),
				);
			case "append_to_note":
				return this.propose(name, input, turn, (text, firstId) =>
					proposeAppend(
						text,
						String(input.text ?? ""),
						input.under_heading === undefined ? undefined : String(input.under_heading),
						firstId,
					),
				);
			case "set_properties":
				return this.setProperties(input, turn);
			default:
				return error(name, `Unknown tool: ${name}`, "unknown tool");
		}
	}

	private async createNote(input: Record<string, unknown>, turn: WriteTurn): Promise<ToolOutcome> {
		const name = "create_note";
		let path = normalizePath(String(input.path ?? "").trim());
		if (!path || path === "/") return error(name, "No path given.", "no path");
		if (!/\.[^/]+$/.test(path)) path += ".md";
		if (!path.endsWith(".md")) return error(name, "Only markdown notes can be created.", `${path} (not .md)`);

		const blocked = this.blockedReason(path);
		if (blocked) return error(name, blocked, `${path} (blocked)`);

		const content = String(input.content ?? "");
		if (content.length > MAX_NEW_NOTE_CHARS) {
			return error(name, `Note too long (${content.length} characters, limit ${MAX_NEW_NOTE_CHARS}). This is for small notes.`, `${path} (too long)`);
		}
		if (hasProposals(content)) return error(name, "The content contains review markers.", `${path} (markers)`);

		if (this.app.vault.getAbstractFileByPath(path) || resolveFile(this.app, path)) {
			return error(name, `A file already exists at "${path}". Use edit_note or append_to_note to change it.`, `${path} (exists)`);
		}
		if (!turn.claim(path)) return tooMany(name, path);

		await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
		const file = await this.app.vault.create(path, content);
		return {
			content: `Created ${file.path}. It is already in the vault; no review is needed.`,
			isError: false,
			summary: { name, detail: `created ${file.path}`, link: file.path },
		};
	}

	/**
	 * Writes a proposal into an existing note. A note with proposals from an
	 * earlier reply is refused — the user hasn't answered those yet. Proposals
	 * from this same reply are fine (an edit plus an append is a normal pair),
	 * and the check runs inside `vault.process`, against the text actually being
	 * replaced, so parallel calls see each other's blocks.
	 */
	private async propose(
		name: string,
		input: Record<string, unknown>,
		turn: WriteTurn,
		build: (text: string, firstId: number) => BuildResult,
	): Promise<ToolOutcome> {
		const found = this.existingNote(name, input);
		if ("outcome" in found) return found.outcome;
		const { file } = found;
		if (!turn.claim(file.path)) return tooMany(name, file.path);

		let result: BuildResult | null = null;
		await this.app.vault.process(file, (current) => {
			if (hasProposals(current) && !turn.proposed.has(file.path)) {
				result = {
					ok: false,
					error: `${file.path} already has changes waiting for the user's review. Don't propose more until they accept or reject those.`,
				};
				return current;
			}
			const built = build(current, nextProposalId(current));
			// A match inside an existing block would nest markers, which the review
			// side rightly refuses to guess at. Catch it before it is written.
			result =
				built.ok && parseProposals(built.text).broken.length > 0
					? { ok: false, error: "That edit overlaps a change already proposed in this note. Fold it into that change instead." }
					: built;
			if (!result.ok) return current;
			turn.proposed.add(file.path);
			return result.text;
		});

		const built = result as BuildResult | null;
		if (!built || !built.ok) {
			return error(name, built?.error ?? "Could not write the proposal.", `${file.path} (not written)`);
		}

		const count = `${built.changes} change${built.changes === 1 ? "" : "s"}`;
		return {
			content: `Proposed ${count} in ${file.path}. They are written into the note between review markers and are NOT applied yet — the user will accept, adjust, or reject them in the note. Tell them it is waiting for their review, with a [[wikilink]] to the note.`,
			isError: false,
			summary: { name, detail: `${count} to review in ${file.basename}`, link: file.path },
		};
	}

	private async setProperties(input: Record<string, unknown>, turn: WriteTurn): Promise<ToolOutcome> {
		const name = "set_properties";
		const found = this.existingNote(name, input);
		if ("outcome" in found) return found.outcome;
		const { file } = found;

		const props = input.properties;
		if (!props || typeof props !== "object" || Array.isArray(props)) {
			return error(name, "properties must be an object of name → value.", `${file.path} (bad input)`);
		}
		const entries = Object.entries(props as Record<string, unknown>);
		if (entries.length === 0) return error(name, "No properties given.", `${file.path} (nothing to set)`);
		if (entries.length > MAX_PROPERTIES) {
			return error(name, `Too many properties (${entries.length}, limit ${MAX_PROPERTIES}).`, `${file.path} (too many)`);
		}
		if (!turn.claim(file.path)) return tooMany(name, file.path);

		const previous: Record<string, unknown> = {};
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const [key, value] of entries) {
				previous[key] = key in fm ? fm[key] : null;
				if (value === null) delete fm[key];
				else fm[key] = value;
			}
		});

		const keys = entries.map(([k]) => k).join(", ");
		return {
			content: `Updated frontmatter of ${file.path} (applied immediately). Previous values, null meaning the property did not exist — use these to undo:\n${JSON.stringify(previous, null, 2)}`,
			isError: false,
			summary: { name, detail: `${file.basename}: ${keys}`, link: file.path },
		};
	}

	private existingNote(
		name: string,
		input: Record<string, unknown>,
	): { file: TFile } | { outcome: ToolOutcome } {
		const rawPath = String(input.path ?? "");
		const file = resolveFile(this.app, rawPath);
		if (!file) {
			return { outcome: error(name, `No note at "${rawPath}". Use search_vault or list_files to find it, or create_note for a new one.`, `${rawPath} (not found)`) };
		}
		if (file.extension !== "md") {
			return { outcome: error(name, `${file.path} is not a markdown note; only notes can be edited.`, `${file.path} (not a note)`) };
		}
		const blocked = this.blockedReason(file.path);
		if (blocked) return { outcome: error(name, blocked, `${file.path} (blocked)`) };
		return { file };
	}

	/** The config folder holds settings, plugins, and saved chats — never the model's to touch. */
	private blockedReason(path: string): string | null {
		const config = this.app.vault.configDir;
		if (path === config || path.startsWith(`${config}/`) || path.split("/").some((s) => s.startsWith("."))) {
			return "That path is in a hidden or configuration folder, which cannot be written.";
		}
		return null;
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (!folder) return;
		let current = "";
		for (const segment of folder.split("/")) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
		}
	}
}

function parseEdits(value: unknown): Edit[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
		.map((e) => ({ find: String(e.find ?? ""), replace: String(e.replace ?? "") }));
}

function tooMany(name: string, path: string): ToolOutcome {
	return error(
		name,
		`Not written: a reply may change at most ${MAX_NOTES_PER_TURN} notes. Editing is for small updates — describe the rest in chat and let the user decide.`,
		`${path} (note limit)`,
	);
}

function error(name: string, content: string, detail: string): ToolOutcome {
	return { content, isError: true, summary: { name, detail } };
}
