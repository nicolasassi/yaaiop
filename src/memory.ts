import type { ChatProvider } from "./providers";
import { newSessionId } from "./store";

/**
 * One durable fact the user chose to keep. Memories are plain sentences, not
 * structured data — they are injected into the system prompt verbatim, so what
 * the user reads in settings is exactly what the model is told.
 */
export interface Memory {
	id: string;
	text: string;
	createdAt: number;
}

/**
 * Hard ceiling on how many memories can be kept.
 *
 * Every memory is re-sent on every message of every chat, so the list is a
 * standing tax on each request rather than a one-off cost. 50 short lines is a
 * few hundred tokens; letting it grow unbounded would quietly turn into a much
 * larger one.
 */
export const MAX_MEMORIES = 50;

/** Memories longer than this are the user writing a note, not a fact. */
export const MAX_MEMORY_CHARS = 300;

/** How much of a turn the extractor sees. Enough for context, cheap to send. */
const MAX_TURN_CHARS = 4000;

/** Small ceiling — the extractor returns a short list or nothing. */
const EXTRACT_MAX_TOKENS = 1024;

export function newMemory(text: string): Memory {
	return { id: newSessionId(), text: text.trim(), createdAt: Date.now() };
}

/**
 * The memories block appended to the system prompt.
 *
 * Deliberately the last section built, so the stable part of the prompt (base
 * instructions, CLAUDE.md, extra instructions) stays byte-identical when a
 * memory is added and only the tail of the cached prefix is invalidated.
 */
export function memoriesSection(memories: Memory[]): string | null {
	const lines = memories.map((m) => m.text.trim()).filter(Boolean);
	if (lines.length === 0) return null;

	return [
		"Things the user has kept from past conversations, one by one, because they wanted you to know them going forward. They are background about the user and their vault, not something you read in a note just now — so do not cite them as if they came from a file.",
		"",
		...lines.map((line) => `- ${line}`),
		"",
		"They can go stale. If a note contradicts one, trust the note and say so.",
	].join("\n");
}

const EXTRACT_SYSTEM = [
	"You read one exchange between a user and an assistant that has read-only access to the user's Obsidian vault, and pick out anything worth remembering for future conversations.",
	"",
	"A memory is a short standalone fact that will still be true and still be useful in a month, written so it makes sense with no other context.",
	"",
	"Worth keeping:",
	"- Stable facts about the user: their work, projects, tools, people in their life, recurring commitments.",
	"- How this vault is organised: what a folder holds, what a tag means, a naming convention, where a kind of note lives.",
	"- Standing preferences about answers: language, format, length, how they want notes cited.",
	"- A correction the user made that the assistant would otherwise repeat.",
	"",
	"Not worth keeping:",
	"- Anything the assistant simply read out of a note. The vault already holds it and can be searched again.",
	"- The subject of this particular conversation, a one-off request, or anything only true today.",
	"- Anything already covered by an existing memory, however differently worded.",
	"- Anything the user did not actually say. Do not infer, and do not turn the assistant's own claims into facts about the user.",
	"",
	"Write each one in the third person about the user (\"Prefers…\", \"Works as…\", \"Keeps…\"), one fact per memory, under 200 characters, no first person and no reference to \"this chat\".",
	"",
	"Most exchanges contain nothing worth keeping. Returning an empty list is the normal, expected answer — never pad the list to seem useful.",
].join("\n");

const EXTRACT_SCHEMA = {
	type: "object" as const,
	properties: {
		memories: {
			type: "array",
			items: { type: "string" },
			description:
				"Facts worth remembering, at most three. Empty when the exchange contains none, which is the common case.",
		},
	},
	required: ["memories"],
};

function clip(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Asks the provider's cheap utility model whether anything in the last exchange
 * is worth keeping.
 *
 * This is a second, separate request — it does not ride along on the chat turn.
 * Doing it inline would mean either giving the chat model a tool it would fire
 * mid-answer, or growing the main system prompt for every message. A short
 * request to a small model is both cheaper and easier to reason about, and it
 * can fail without touching the answer the user is reading.
 */
export async function extractMemories(
	provider: ChatProvider,
	userText: string,
	assistantText: string,
	existing: Memory[],
	signal: AbortSignal,
): Promise<string[]> {
	const answer = assistantText.trim();
	if (!answer) return [];

	const known = existing.map((m) => m.text.trim()).filter(Boolean);
	const prompt = [
		known.length > 0
			? `Memories already kept — do not repeat these, or restate them in other words:\n${known.map((t) => `- ${t}`).join("\n")}`
			: "No memories have been kept yet.",
		"",
		"The exchange:",
		"",
		`<user>\n${clip(userText, MAX_TURN_CHARS)}\n</user>`,
		"",
		`<assistant>\n${clip(answer, MAX_TURN_CHARS)}\n</assistant>`,
	].join("\n");

	const result = await provider.structuredCompletion(
		{
			model: provider.info.utilityModel,
			system: EXTRACT_SYSTEM,
			prompt,
			maxTokens: EXTRACT_MAX_TOKENS,
			schema: EXTRACT_SCHEMA,
		},
		signal,
	);

	return normalise(result, known);
}

/**
 * The model's output is untrusted shape as well as untrusted content: anything
 * that is not a usable short string is dropped rather than repaired.
 */
function normalise(result: unknown, known: string[]): string[] {
	if (!result || typeof result !== "object") return [];
	const raw = (result as { memories?: unknown }).memories;
	if (!Array.isArray(raw)) return [];

	const seen = new Set(known.map((t) => t.toLowerCase()));
	const out: string[] = [];

	for (const item of raw) {
		if (typeof item !== "string") continue;
		const text = clip(item, MAX_MEMORY_CHARS);
		if (text.length < 3) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(text);
		if (out.length === 3) break;
	}

	return out;
}
