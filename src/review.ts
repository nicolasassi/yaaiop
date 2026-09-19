import { App, MarkdownView, Menu, Notice, Plugin, debounce, editorInfoField } from "obsidian";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import {
	hasProposals,
	minimalChange,
	parseProposals,
	recordOutcome,
	resolveProposals,
	type Resolution,
} from "./proposals";

/**
 * Where the user settles proposals: tinted old/new lines and per-block buttons
 * in the editor, a header button while a note has any, and two commands. All
 * of it works the same on a phone, which is why none of it is a hover or a
 * modal diff.
 */
export function registerReview(plugin: Plugin): void {
	plugin.registerEditorExtension(reviewField);

	const actions = new Map<MarkdownView, HTMLElement>();
	const refresh = () => {
		const open = new Set<MarkdownView>();
		for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			open.add(view);
			const pending = hasProposals(view.getViewData());
			const button = actions.get(view);
			if (pending && !button) {
				actions.set(
					view,
					view.addAction("file-diff", "Review proposed changes", (evt) =>
						reviewMenu(plugin.app, view, evt),
					),
				);
			} else if (!pending && button) {
				button.remove();
				actions.delete(view);
			}
		}
		for (const view of actions.keys()) if (!open.has(view)) actions.delete(view);
	};
	const refreshSoon = debounce(refresh, 300, true);

	plugin.registerEvent(plugin.app.workspace.on("file-open", refreshSoon));
	plugin.registerEvent(plugin.app.workspace.on("layout-change", refreshSoon));
	plugin.registerEvent(plugin.app.workspace.on("editor-change", refreshSoon));
	// A proposal written by the chat lands through the vault, not the editor.
	plugin.registerEvent(plugin.app.vault.on("modify", refreshSoon));
	plugin.app.workspace.onLayoutReady(refresh);
	plugin.register(() => {
		for (const button of actions.values()) button.remove();
		actions.clear();
	});

	for (const [mode, id, name] of [
		["accept", "accept-proposed-changes", "Accept proposed changes in this note"],
		["keep-old", "reject-proposed-changes", "Keep the old version (reject proposed changes)"],
	] as const) {
		plugin.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !hasProposals(view.getViewData())) return false;
				if (!checking) void resolveInMarkdownView(plugin.app, view, mode);
				return true;
			},
		});
	}
}

function reviewMenu(app: App, view: MarkdownView, evt: MouseEvent): void {
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle("Accept all changes")
			.setIcon("check")
			.onClick(() => void resolveInMarkdownView(app, view, "accept")),
	);
	menu.addItem((item) =>
		item
			.setTitle("Keep old version")
			.setIcon("undo-2")
			.onClick(() => void resolveInMarkdownView(app, view, "keep-old")),
	);
	menu.showAtMouseEvent(evt);
}

/**
 * Settles every block in a note. Goes through the editor when one is showing
 * the note, so the result is one step on its undo stack; reading mode has no
 * live editor, so there it goes through the vault.
 */
async function resolveInMarkdownView(app: App, view: MarkdownView, mode: Resolution): Promise<void> {
	const file = view.file;
	if (!file) return;

	if (view.getMode() === "source") {
		const editor = view.editor;
		const before = editor.getValue();
		const result = resolveProposals(before, mode);
		if (result.resolved > 0) {
			const change = minimalChange(before, result.text);
			editor.replaceRange(change.insert, editor.offsetToPos(change.from), editor.offsetToPos(change.to));
		}
		report(file.path, mode, result.resolved, result.broken);
		return;
	}

	let resolved = 0;
	let broken: number[] = [];
	await app.vault.process(file, (text) => {
		const result = resolveProposals(text, mode);
		resolved = result.resolved;
		broken = result.broken;
		return result.text;
	});
	report(file.path, mode, resolved, broken);
}

function resolveInEditorView(view: EditorView, mode: Resolution, id: number): void {
	const before = view.state.doc.toString();
	const result = resolveProposals(before, mode, id);
	if (result.resolved === 0) {
		new Notice("YAAIOP: this change's markers were edited and can't be read. Fix or remove them by hand.");
		return;
	}
	view.dispatch({ changes: minimalChange(before, result.text) });
	const path = view.state.field(editorInfoField, false)?.file?.path;
	if (path) recordOutcome(path, mode);
}

function report(path: string, mode: Resolution, resolved: number, broken: number[]): void {
	if (resolved > 0) recordOutcome(path, mode);
	const parts: string[] = [];
	if (resolved > 0) {
		const n = `${resolved} change${resolved === 1 ? "" : "s"}`;
		parts.push(mode === "accept" ? `Accepted ${n}.` : `Kept the old version for ${n}.`);
	}
	if (broken.length > 0) {
		parts.push(
			`${broken.length} couldn't be read because its markers were edited — fix or remove ${broken.length === 1 ? "it" : "them"} by hand.`,
		);
	}
	if (parts.length > 0) new Notice(`YAAIOP: ${parts.join(" ")}`);
}

class BlockControls extends WidgetType {
	constructor(private readonly id: number) {
		super();
	}

	eq(other: BlockControls): boolean {
		return other.id === this.id;
	}

	toDOM(view: EditorView): HTMLElement {
		const el = createDiv({ cls: "yaaiop-review-controls" });
		el.createSpan({ cls: "yaaiop-review-label", text: "Proposed change" });
		const accept = el.createEl("button", { cls: "mod-cta", text: "Accept" });
		const keep = el.createEl("button", { text: "Keep old" });
		// Without this the tap first moves the cursor into the block, which on a
		// phone also pops the keyboard up over the buttons.
		for (const button of [accept, keep]) {
			button.addEventListener("mousedown", (evt) => evt.preventDefault());
		}
		accept.addEventListener("click", () => resolveInEditorView(view, "accept", this.id));
		keep.addEventListener("click", () => resolveInEditorView(view, "keep-old", this.id));
		return el;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function buildDecorations(state: EditorState): DecorationSet {
	const text = state.doc.toString();
	if (!hasProposals(text)) return Decoration.none;

	const ranges: Range<Decoration>[] = [];
	for (const block of parseProposals(text).blocks) {
		const first = state.doc.line(block.startLine + 1);
		ranges.push(
			Decoration.widget({ widget: new BlockControls(block.id), block: true, side: -1 }).range(first.from),
		);
		for (let n = block.startLine; n <= block.endLine; n++) {
			const isMarker = n === block.oldMarkerLine || n === block.newMarkerLine || n === block.endLine;
			const isNew = block.newMarkerLine !== null && n > block.newMarkerLine;
			const cls = isMarker ? "yaaiop-review-marker" : isNew ? "yaaiop-review-new" : "yaaiop-review-old";
			ranges.push(Decoration.line({ class: cls }).range(state.doc.line(n + 1).from));
		}
	}
	return Decoration.set(ranges, true);
}

/**
 * A state field rather than a view plugin because block widgets (the button
 * row) are only allowed from state. Rebuilt on every change: notes are small
 * and the early `hasProposals` exit keeps notes without proposals cheap.
 */
const reviewField = StateField.define<DecorationSet>({
	create: buildDecorations,
	update: (decorations, tr) => (tr.docChanged ? buildDecorations(tr.state) : decorations),
	provide: (field) => EditorView.decorations.from(field),
});
