import { App, TFile, prepareSimpleSearch } from "obsidian";
import { classifyFile, isReadableAsText, type FileKind } from "./files";

export interface SearchHit {
	path: string;
	kind: FileKind;
	score: number;
	snippet: string;
}

export interface SearchResult {
	hits: SearchHit[];
	/** Which backend answered, so the UI and the model can say so honestly. */
	method: "smart-connections" | "keyword";
}

/** Minimal shape we rely on from Smart Connections. Everything is feature-detected. */
interface SmartLookupResult {
	score?: number;
	key?: string;
	item?: { path?: string; key?: string };
}

interface SmartSourcesCollection {
	lookup(params: {
		hypotheticals: string[];
		filter?: { limit?: number };
	}): Promise<SmartLookupResult[] | { error: string }>;
}

/**
 * Resolves a model-supplied path to a real file. The model works from paths we
 * gave it, but it can still mangle one (drop the extension, use just the
 * basename), so we degrade gracefully rather than erroring on a near-miss.
 *
 * Covers every file in the vault, not just notes — attachments are addressable.
 */
export function resolveFile(app: App, rawPath: string): TFile | null {
	const path = rawPath.trim().replace(/^\[\[|\]\]$/g, "").split("#")[0];
	if (!path) return null;

	const direct = app.vault.getAbstractFileByPath(path);
	if (direct instanceof TFile) return direct;

	const withMd = app.vault.getAbstractFileByPath(`${path}.md`);
	if (withMd instanceof TFile) return withMd;

	// Fall back to Obsidian's own link resolution, then to a basename match.
	const linked = app.metadataCache.getFirstLinkpathDest(path, "");
	if (linked) return linked;

	const target = path.toLowerCase();
	return (
		app.vault
			.getFiles()
			.find((f) => f.basename.toLowerCase() === target || f.path.toLowerCase() === target) ?? null
	);
}

function buildSnippet(content: string, offset: number, radius = 160): string {
	const start = Math.max(0, offset - radius);
	const end = Math.min(content.length, offset + radius);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < content.length ? "…" : "";
	return (prefix + content.slice(start, end) + suffix).replace(/\s+/g, " ").trim();
}

/** Notes that link to or embed `path`. resolvedLinks covers both. */
export function referencingNotes(app: App, path: string): string[] {
	return Object.entries(app.metadataCache.resolvedLinks)
		.filter(([source, targets]) => source !== path && path in targets)
		.map(([source]) => source);
}

/**
 * The prose around where a file is embedded.
 *
 * An image's filename is usually meaningless ("IMG-20260730-WA0071.jpg"); what
 * actually describes it is the sentence next to the embed. This is what makes an
 * attachment findable and interpretable at all.
 */
export async function attachmentContext(
	app: App,
	file: TFile,
	maxNotes = 3,
): Promise<{ notes: string[]; excerpts: string[] }> {
	const notes = referencingNotes(app, file.path);
	const excerpts: string[] = [];

	for (const notePath of notes.slice(0, maxNotes)) {
		const note = app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) continue;
		try {
			const content = await app.vault.cachedRead(note);
			// Embeds may use the full path, the filename, or just the basename.
			let index = content.indexOf(file.path);
			if (index === -1) index = content.indexOf(file.name);
			if (index === -1) index = content.indexOf(file.basename);
			excerpts.push(`${notePath}: ${buildSnippet(content, Math.max(0, index), 200)}`);
		} catch {
			continue;
		}
	}

	return { notes, excerpts };
}

export class VaultSearch {
	constructor(private app: App) {}

	private smartSources(): SmartSourcesCollection | null {
		try {
			// Smart Connections exposes its environment on the plugin instance and
			// mirrors it on the window. Try both: the window copy only appears once
			// the environment has finished loading.
			const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
				.plugins?.plugins;
			const sc = plugins?.["smart-connections"] as { env?: unknown } | undefined;
			// Smart Connections mirrors its environment onto the window object.
			const env = (sc?.env ?? (window as unknown as { smart_env?: unknown }).smart_env) as
				| { smart_sources?: SmartSourcesCollection }
				| undefined;
			const sources = env?.smart_sources;
			return typeof sources?.lookup === "function" ? sources : null;
		} catch {
			return null;
		}
	}

	smartConnectionsAvailable(): boolean {
		return this.smartSources() !== null;
	}

	async search(
		query: string,
		limit: number,
		preferSemantic: boolean,
		includeAttachments: boolean,
	): Promise<SearchResult> {
		if (preferSemantic) {
			const semantic = await this.semanticSearch(query, limit);
			// An empty result is not a failure — but a null one means the API was
			// missing or threw, and keyword search is strictly better than nothing.
			if (semantic !== null && semantic.length > 0) {
				return { hits: semantic, method: "smart-connections" };
			}
		}
		return {
			hits: await this.keywordSearch(query, limit, includeAttachments),
			method: "keyword",
		};
	}

	private async semanticSearch(query: string, limit: number): Promise<SearchHit[] | null> {
		const sources = this.smartSources();
		if (!sources) return null;

		try {
			const raw = await sources.lookup({ hypotheticals: [query], filter: { limit } });
			if (!Array.isArray(raw)) return null;

			const seen = new Set<string>();
			const hits: SearchHit[] = [];

			for (const result of raw) {
				// Block-level results are keyed "path#heading"; collapse to the file.
				const key = result.item?.path ?? result.item?.key ?? result.key ?? "";
				const path = key.split("#")[0];
				if (!path || seen.has(path)) continue;

				const file = resolveFile(this.app, path);
				if (!file) continue;
				seen.add(file.path);

				const kind = classifyFile(file);
				const snippet = isReadableAsText(kind)
					? buildSnippet(await this.app.vault.cachedRead(file), 0, 220)
					: ((await attachmentContext(this.app, file, 1)).excerpts[0] ??
						"(no surrounding text)");

				hits.push({
					path: file.path,
					kind,
					score: typeof result.score === "number" ? result.score : 0,
					snippet,
				});
				if (hits.length >= limit) break;
			}
			return hits;
		} catch (err) {
			console.warn("[yaaiop] Smart Connections lookup failed:", err);
			return null;
		}
	}

	private async keywordSearch(
		query: string,
		limit: number,
		includeAttachments: boolean,
	): Promise<SearchHit[]> {
		const matcher = prepareSimpleSearch(query);
		const files = this.app.vault.getFiles();

		const hits: SearchHit[] = [];
		/** Text-file scores, reused to rank the attachments those files embed. */
		const textScores = new Map<string, number>();

		// Pass 1: everything we can read as text.
		for (const file of files) {
			const kind = classifyFile(file);
			if (!isReadableAsText(kind)) continue;

			const titleMatch = matcher(file.basename);
			let content: string;
			try {
				content = await this.app.vault.cachedRead(file);
			} catch {
				continue;
			}
			const bodyMatch = matcher(content);
			if (!titleMatch && !bodyMatch) continue;

			// Title hits are weighted up: a filename is usually a stronger signal
			// of what a file is about than any single match in its body.
			const score = (titleMatch?.score ?? 0) * 2 + (bodyMatch?.score ?? 0);
			textScores.set(file.path, score);
			hits.push({
				path: file.path,
				kind,
				score,
				snippet: buildSnippet(content, bodyMatch?.matches?.[0]?.[0] ?? 0),
			});
		}

		// Pass 2: attachments, scored on their own filename plus the relevance of
		// whatever notes embed them — an image is usually found via its context.
		if (includeAttachments) {
			for (const file of files) {
				const kind = classifyFile(file);
				if (isReadableAsText(kind)) continue;

				const titleMatch = matcher(file.basename);
				const referencing = referencingNotes(this.app, file.path);
				const inherited = referencing.reduce(
					(best, note) => Math.max(best, textScores.get(note) ?? 0),
					0,
				);
				if (!titleMatch && inherited === 0) continue;

				const context = await attachmentContext(this.app, file, 1);
				hits.push({
					path: file.path,
					kind,
					// Inherited context is a weaker signal than the file's own name.
					score: (titleMatch?.score ?? 0) * 2 + inherited * 0.5,
					snippet: context.excerpts[0] ?? `Referenced by ${referencing.length} note(s)`,
				});
			}
		}

		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}
