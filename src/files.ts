import { App, TFile } from "obsidian";
import type { MediaAttachment, MediaCapabilities } from "./providers";

export type FileKind = "note" | "text" | "image" | "pdf" | "other";

/**
 * Raster formats every current vision model accepts. SVG is deliberately absent:
 * it is XML, so it is handled as text — which is also more useful, since the
 * model can read the markup.
 */
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** Extensions worth reading as plain text even though they are not notes. */
const TEXT_EXTENSIONS = new Set([
	"txt",
	"csv",
	"tsv",
	"json",
	"jsonl",
	"yaml",
	"yml",
	"xml",
	"svg",
	"html",
	"css",
	"js",
	"jsx",
	"ts",
	"tsx",
	"py",
	"rb",
	"go",
	"rs",
	"java",
	"sh",
	"bash",
	"zsh",
	"sql",
	"toml",
	"ini",
	"conf",
	"log",
	"canvas",
	"bib",
	"tex",
]);

export function classifyFile(file: TFile): FileKind {
	const ext = file.extension.toLowerCase();
	if (ext === "md") return "note";
	if (ext === "pdf") return "pdf";
	if (ext in IMAGE_MIME) return "image";
	if (TEXT_EXTENSIONS.has(ext)) return "text";
	return "other";
}

export function isReadableAsText(kind: FileKind): boolean {
	return kind === "note" || kind === "text";
}

export function imageMimeType(file: TFile): string | null {
	return IMAGE_MIME[file.extension.toLowerCase()] ?? null;
}

export function describeKind(kind: FileKind): string {
	switch (kind) {
		case "note":
			return "note";
		case "text":
			return "text file";
		case "image":
			return "image";
		case "pdf":
			return "PDF";
		default:
			return "file";
	}
}

/**
 * Base64-encodes bytes without blowing the call stack.
 *
 * `String.fromCharCode(...bytes)` is the obvious one-liner and throws
 * RangeError on anything more than a few hundred KB — which is most images.
 */
export function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Shrinks an image so its long edge is at most `maxEdge`.
 *
 * Vault photos are routinely several thousand pixels wide. Sending them
 * untouched is slow on mobile data and expensive — image cost scales with
 * resolution — while adding nothing for a model that downsamples anyway.
 *
 * Returns null if anything at all goes wrong (unsupported codec, no canvas,
 * memory pressure); callers then fall back to the original bytes rather than
 * losing the attachment.
 */
export async function downscaleImage(
	buffer: ArrayBuffer,
	mediaType: string,
	maxEdge: number,
): Promise<{ data: ArrayBuffer; mediaType: string } | null> {
	try {
		if (typeof createImageBitmap !== "function") return null;

		const source = new Blob([buffer], { type: mediaType });
		const bitmap = await createImageBitmap(source);
		const longEdge = Math.max(bitmap.width, bitmap.height);

		if (longEdge <= maxEdge) {
			bitmap.close?.();
			return null;
		}

		const scale = maxEdge / longEdge;
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));

		const canvas = createEl("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			bitmap.close?.();
			return null;
		}
		ctx.drawImage(bitmap, 0, 0, width, height);
		bitmap.close?.();

		// Re-encode transparent formats as PNG, everything else as JPEG.
		const outType = mediaType === "image/png" || mediaType === "image/webp" ? "image/png" : "image/jpeg";
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, outType, 0.85),
		);
		if (!blob) return null;

		return { data: await blob.arrayBuffer(), mediaType: outType };
	} catch (err) {
		console.warn("[yaaiop] image downscale failed, sending original:", err);
		return null;
	}
}

/**
 * Per-image ceiling enforced after downscaling, independent of the user's
 * file-size setting. Providers reject images beyond roughly this size, so
 * exceeding it means a failed request rather than an expensive one.
 */
const HARD_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;

export interface MediaLoadOptions {
	maxBytes: number;
	maxImageEdge: number;
	capabilities: MediaCapabilities;
}

export interface MediaLoadResult {
	attachment?: MediaAttachment;
	/** Always set: what to tell the model, whether or not bytes came through. */
	note: string;
}

/**
 * Loads an image or PDF as a model-ready attachment, or explains why it could
 * not. Refusals are returned as prose rather than thrown so the model can adapt
 * (e.g. read the note that embeds the image instead).
 */
export async function loadMedia(
	app: App,
	file: TFile,
	kind: FileKind,
	options: MediaLoadOptions,
): Promise<MediaLoadResult> {
	const sizeMB = (file.stat.size / (1024 * 1024)).toFixed(1);

	if (kind === "image" && !options.capabilities.images) {
		return { note: "The current model cannot view images. Switch models to inspect this file." };
	}
	if (kind === "pdf" && !options.capabilities.documents) {
		return { note: "The current model cannot read PDFs. Switch models to inspect this file." };
	}
	if (file.stat.size > options.maxBytes) {
		return {
			note: `File is ${sizeMB} MB, over the configured attachment limit. Raise "Max attachment size" in settings to include it.`,
		};
	}

	let buffer = await app.vault.readBinary(file);
	let mediaType = kind === "pdf" ? "application/pdf" : imageMimeType(file);
	if (!mediaType) return { note: "Unsupported file type." };

	let note = `Attached ${describeKind(kind)}: ${file.path}`;

	if (kind === "image") {
		const shrunk = await downscaleImage(buffer, mediaType, options.maxImageEdge);
		if (shrunk) {
			buffer = shrunk.data;
			mediaType = shrunk.mediaType;
			note += ` (downscaled to fit ${options.maxImageEdge}px)`;
		}

		// Backstop for the case where downscaling silently did nothing — an
		// unsupported codec, a webview without canvas, memory pressure. Without
		// this, a large photo would be base64'd and rejected by the API (or
		// billed at full resolution) instead of failing here with an explanation.
		if (buffer.byteLength > HARD_IMAGE_LIMIT_BYTES) {
			return {
				note: `Image is ${(buffer.byteLength / (1024 * 1024)).toFixed(1)} MB even after downscaling, above the ${HARD_IMAGE_LIMIT_BYTES / (1024 * 1024)} MB per-image ceiling, so it was not attached. Lower "Max image edge" in settings.`,
			};
		}
	}

	return {
		attachment: {
			kind: kind === "pdf" ? "document" : "image",
			mediaType,
			data: toBase64(buffer),
			name: file.path,
		},
		note,
	};
}
