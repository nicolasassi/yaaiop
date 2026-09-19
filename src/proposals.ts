/**
 * Proposed changes, written into the note itself.
 *
 * Edits are never applied directly. The note gets a block holding the current
 * lines and the proposed ones, fenced by Obsidian comments so the markers
 * vanish in reading mode:
 *
 *   %% yaaiop:old 1 %%
 *   current lines
 *   %% yaaiop:new 1 %%
 *   proposed lines
 *   %% yaaiop:end 1 %%
 *
 * The user reviews it in the editor they already use — on a phone that beats
 * any diff UI — and may rewrite the new part, or delete either part outright.
 * Accepting keeps whatever is left of the new part; "keep old" keeps the old.
 *
 * Nothing in this file touches Obsidian: plain text in, plain text out.
 */

const MARKER = /^%%[ \t]*yaaiop:(old|new|end)[ \t]+(\d+)[ \t]*%%[ \t]*\r?$/;
const ANY_MARKER = /^%%[ \t]*yaaiop:(?:old|new|end)[ \t]+\d+[ \t]*%%[ \t]*\r?$/m;

/** Largest old or new side of a single change. Past this it is not a small edit. */
export const MAX_CHANGE_CHARS = 4000;
export const MAX_EDITS_PER_CALL = 8;

export type Resolution = "accept" | "keep-old";

export interface ProposalBlock {
	id: number;
	/** First and last line of the block, markers included (0-based, inclusive). */
	startLine: number;
	endLine: number;
	/** null when the user deleted that part, marker and all. */
	oldLines: string[] | null;
	newLines: string[] | null;
	/** Where each marker sits, for editor decorations. */
	oldMarkerLine: number | null;
	newMarkerLine: number | null;
}

export interface ParsedProposals {
	blocks: ProposalBlock[];
	/** Ids whose markers no longer form a readable block. Left untouched. */
	broken: number[];
}

export function hasProposals(text: string): boolean {
	return ANY_MARKER.test(text);
}

export function parseProposals(text: string): ParsedProposals {
	const lines = text.split("\n");
	const byId = new Map<number, { kind: string; line: number }[]>();
	lines.forEach((line, i) => {
		const m = MARKER.exec(line);
		if (!m) return;
		const id = Number(m[2]);
		const list = byId.get(id) ?? [];
		list.push({ kind: m[1], line: i });
		byId.set(id, list);
	});

	const candidates: ProposalBlock[] = [];
	const broken = new Set<number>();

	for (const [id, markers] of byId) {
		const of = (kind: string) => markers.filter((m) => m.kind === kind).map((m) => m.line);
		const [olds, news, ends] = [of("old"), of("new"), of("end")];
		const oldLine = olds[0] ?? null;
		const newLine = news[0] ?? null;
		const endLine = ends[0];

		const wellFormed =
			ends.length === 1 &&
			olds.length <= 1 &&
			news.length <= 1 &&
			(oldLine !== null || newLine !== null) &&
			(oldLine === null || oldLine < endLine) &&
			(newLine === null || newLine < endLine) &&
			(oldLine === null || newLine === null || oldLine < newLine);
		if (!wellFormed) {
			broken.add(id);
			continue;
		}

		candidates.push({
			id,
			startLine: oldLine ?? (newLine as number),
			endLine,
			oldLines: oldLine === null ? null : lines.slice(oldLine + 1, newLine ?? endLine),
			newLines: newLine === null ? null : lines.slice(newLine + 1, endLine),
			oldMarkerLine: oldLine,
			newMarkerLine: newLine,
		});
	}

	// One block inside another means markers were moved around by hand, and
	// guessing which text belongs to which change is how text gets lost.
	for (const a of candidates) {
		for (const b of candidates) {
			if (a !== b && a.startLine <= b.endLine && b.startLine <= a.endLine) broken.add(a.id);
		}
	}

	return {
		blocks: candidates
			.filter((b) => !broken.has(b.id))
			.sort((a, b) => a.startLine - b.startLine),
		broken: [...broken].sort((a, b) => a - b),
	};
}

/** The id a new block should take so it cannot collide with one already in the note. */
export function nextProposalId(text: string): number {
	const { blocks, broken } = parseProposals(text);
	return Math.max(0, ...blocks.map((b) => b.id), ...broken) + 1;
}

export interface ResolveResult {
	text: string;
	resolved: number;
	broken: number[];
}

/**
 * Settles every block (or just `onlyId`). Accept keeps the new part if it is
 * still there, otherwise the old; keep-old is the mirror image. Neither ever
 * discards both parts unless the user already did.
 */
export function resolveProposals(text: string, mode: Resolution, onlyId?: number): ResolveResult {
	const { blocks, broken } = parseProposals(text);
	const chosen = blocks.filter((b) => onlyId === undefined || b.id === onlyId);
	const lines = text.split("\n");

	// Bottom-up, so splicing one block leaves the line numbers of the rest intact.
	for (const b of [...chosen].reverse()) {
		const keep = mode === "accept" ? (b.newLines ?? b.oldLines) : (b.oldLines ?? b.newLines);
		lines.splice(b.startLine, b.endLine - b.startLine + 1, ...(keep ?? []));
	}

	return {
		text: lines.join("\n"),
		resolved: chosen.length,
		broken: onlyId === undefined ? broken : broken.filter((id) => id === onlyId),
	};
}

/**
 * The smallest single replacement turning `before` into `after`. Applying that
 * instead of swapping the whole document keeps the cursor, scroll position,
 * and undo history sensible.
 */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
	let prefix = 0;
	const max = Math.min(before.length, after.length);
	while (prefix < max && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < max - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}
	return {
		from: prefix,
		to: before.length - suffix,
		insert: after.slice(prefix, after.length - suffix),
	};
}

export interface Edit {
	find: string;
	replace: string;
}

export type BuildResult = { ok: true; text: string; changes: number } | { ok: false; error: string };

/**
 * Wraps each edit in a proposal block. Matches are widened to whole lines,
 * because markers only work on lines of their own and because the user reviews
 * a line far more easily than a fragment of one.
 */
export function proposeEdits(text: string, edits: Edit[], firstId = 1): BuildResult {
	if (edits.length === 0) return fail("No edits given.");
	if (edits.length > MAX_EDITS_PER_CALL) {
		return fail(`Too many edits (${edits.length}). This is for small changes — at most ${MAX_EDITS_PER_CALL} per call.`);
	}

	const bodyStart = frontmatterEnd(text);
	interface Sub { from: number; to: number; replace: string }
	interface Region { start: number; end: number; subs: Sub[] }
	const regions: Region[] = [];

	for (const [i, edit] of edits.entries()) {
		const label = `Edit ${i + 1}`;
		const find = trimNewlines(String(edit.find ?? ""));
		const replace = trimNewlines(String(edit.replace ?? ""));
		if (!find.trim()) return fail(`${label}: "find" is empty.`);
		if (hasProposals(replace)) return fail(`${label}: the replacement contains review markers.`);

		const at = text.indexOf(find);
		if (at === -1) {
			return fail(`${label}: the "find" text is not in the note. Read the note again and copy the text exactly.`);
		}
		if (text.indexOf(find, at + 1) !== -1) {
			return fail(`${label}: the "find" text appears more than once. Include more of the surrounding text so it matches one place.`);
		}
		if (at < bodyStart) return fail(`${label}: that text is in the frontmatter. Use set_properties instead.`);

		const lineEnd = text.indexOf("\n", at + find.length);
		regions.push({
			start: text.lastIndexOf("\n", at - 1) + 1,
			end: lineEnd === -1 ? text.length : lineEnd,
			subs: [{ from: at, to: at + find.length, replace }],
		});
	}

	// Two edits on the same line become one change, so the user sees one
	// before/after for that line instead of two that contradict each other.
	regions.sort((a, b) => a.start - b.start);
	const merged: Region[] = [];
	for (const region of regions) {
		const last = merged[merged.length - 1];
		if (last && region.start <= last.end) {
			const prevSub = last.subs[last.subs.length - 1];
			if (region.subs[0].from < prevSub.to) return fail("Two edits overlap. Combine them into one.");
			last.end = Math.max(last.end, region.end);
			last.subs.push(...region.subs);
		} else {
			merged.push({ ...region, subs: [...region.subs] });
		}
	}

	let out = "";
	let cursor = 0;
	for (const [i, region] of merged.entries()) {
		const oldText = text.slice(region.start, region.end);
		let newText = "";
		let pos = region.start;
		for (const sub of region.subs.sort((a, b) => a.from - b.from)) {
			newText += text.slice(pos, sub.from) + sub.replace;
			pos = sub.to;
		}
		newText += text.slice(pos, region.end);

		if (oldText === newText) return fail(`Change ${i + 1} would not change anything.`);
		if (oldText.length > MAX_CHANGE_CHARS || newText.length > MAX_CHANGE_CHARS) {
			return fail(tooLarge());
		}

		out += text.slice(cursor, region.start) + proposalBlock(firstId + i, oldText, newText);
		cursor = region.end;
	}
	out += text.slice(cursor);

	return { ok: true, text: out, changes: merged.length };
}

/**
 * Proposes adding `addition` at the end of the note, or at the end of the
 * section under `heading` (before the next heading of the same or higher level).
 */
export function proposeAppend(text: string, addition: string, heading?: string, firstId = 1): BuildResult {
	// Leading newlines are kept: a blank first line is how the model separates a
	// new paragraph from prose above it.
	const body = addition.replace(/\s+$/, "");
	if (!body.trim()) return fail("Nothing to add.");
	if (hasProposals(body)) return fail("The text contains review markers.");
	if (body.length > MAX_CHANGE_CHARS) return fail(tooLarge());

	const lines = text.split("\n");
	const bodyStartLine = text.slice(0, frontmatterEnd(text)).split("\n").length - 1;

	let floor = bodyStartLine;
	let sectionEnd = lines.length;

	if (heading?.trim()) {
		const headings = findHeadings(lines, bodyStartLine);
		const wanted = normaliseHeading(heading);
		const index = headings.findIndex((h) => normaliseHeading(h.text) === wanted);
		if (index === -1) {
			const known = headings.slice(0, 20).map((h) => `"${h.text}"`).join(", ");
			return fail(`No heading "${heading}" in this note.${known ? ` Headings: ${known}.` : " It has no headings."}`);
		}
		const target = headings[index];
		floor = target.line + 1;
		const next = headings.slice(index + 1).find((h) => h.level <= target.level);
		sectionEnd = next ? next.line : lines.length;
	}

	// Land right after the section's last content, not after its trailing blank
	// lines, so the gap before the next heading survives.
	let insertAt = sectionEnd;
	while (insertAt > floor && lines[insertAt - 1].trim() === "") insertAt--;

	lines.splice(insertAt, 0, ...proposalBlock(firstId, "", body).split("\n"));
	return { ok: true, text: lines.join("\n"), changes: 1 };
}

function proposalBlock(id: number, oldText: string, newText: string): string {
	const parts = [`%% yaaiop:old ${id} %%`];
	if (oldText) parts.push(oldText);
	parts.push(`%% yaaiop:new ${id} %%`);
	if (newText) parts.push(newText);
	parts.push(`%% yaaiop:end ${id} %%`);
	return parts.join("\n");
}

/** Offset just past the closing `---` line of YAML frontmatter, or 0 without any. */
export function frontmatterEnd(text: string): number {
	const m = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
	return m ? m[0].length : 0;
}

function findHeadings(lines: string[], from: number): { line: number; level: number; text: string }[] {
	const headings: { line: number; level: number; text: string }[] = [];
	let fenced = false;
	for (let i = from; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		if (fenced) continue;
		const m = /^(#{1,6})[ \t]+(.+?)[ \t#]*\r?$/.exec(line);
		if (m) headings.push({ line: i, level: m[1].length, text: m[2] });
	}
	return headings;
}

function normaliseHeading(text: string): string {
	return text.replace(/^#+/, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function trimNewlines(text: string): string {
	return text.replace(/^(\r?\n)+|(\r?\n)+$/g, "");
}

function tooLarge(): string {
	return `That change is too large for an in-note review (over ${MAX_CHANGE_CHARS} characters). Describe it in chat instead, or split it into a smaller change.`;
}

function fail(error: string): BuildResult {
	return { ok: false, error };
}

/**
 * Opens the text part the plugin prepends to a user message to report on
 * earlier proposals. It is for the model; the chat view and titles skip it.
 */
export const REVIEW_STATUS_TAG = "<review_status>";

export function isReviewStatus(text: string): boolean {
	return text.startsWith(REVIEW_STATUS_TAG);
}

/**
 * What the user did with each note's proposals, as far as the plugin saw.
 * Resolving by hand (deleting markers) never passes through here, which is why
 * a missing entry reads as "reviewed" rather than as any particular outcome.
 */
const outcomes = new Map<string, Set<Resolution>>();

export function recordOutcome(path: string, mode: Resolution): void {
	const set = outcomes.get(path) ?? new Set<Resolution>();
	set.add(mode);
	outcomes.set(path, set);
}

export function takeOutcome(path: string): string | null {
	const set = outcomes.get(path);
	outcomes.delete(path);
	if (!set) return null;
	if (set.size > 1) return "accepted some changes and kept the old text for others";
	return set.has("accept")
		? "accepted the changes (possibly after editing them)"
		: "kept the old version";
}
