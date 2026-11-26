import * as fs from "node:fs/promises";
import { standardFontsDir } from "../subagents/pdf-ops.ts";
import type { RawOutlineEntry } from "../../core/book-index.ts";

/**
 * One-time PDF reading for a roadmap folder's books: every page's text, the
 * built-in table of contents (with the PDF page each entry points at), the
 * PDF's own page labels, and how many images each page draws. Pure library
 * code — no model in sight. pdfjs-dist (pure JS, the same engine the pdf-reader
 * already uses); a 1,000-page book takes a few seconds.
 *
 * Text keeps the PDF's own line breaks (pdfjs marks each text run that ends a
 * line), so a page reads as it is laid out rather than as one long line.
 */

export interface ExtractedPage {
	p: number;
	text: string;
	images: number;
}

export interface ExtractedBook {
	pageCount: number;
	title: string | null;
	pages: ExtractedPage[];
	outline: RawOutlineEntry[];
	/** One label per page ("Front Cover", "19", "IBC"), or null when the PDF has none. */
	labels: string[] | null;
}

interface PdfDoc {
	numPages: number;
	getPage(n: number): Promise<PdfPage>;
	getOutline(): Promise<OutlineItem[] | null>;
	getDestination(name: string): Promise<unknown[] | null>;
	getPageIndex(ref: unknown): Promise<number>;
	getPageLabels(): Promise<string[] | null>;
	getMetadata(): Promise<{ info?: { Title?: unknown } }>;
}
interface PdfPage {
	getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean; transform?: number[] }> }>;
	getOperatorList(): Promise<{ fnArray: number[] }>;
	cleanup(): void;
}
interface OutlineItem {
	title: string;
	dest: string | unknown[] | null;
	items?: OutlineItem[];
}

async function openDoc(filePath: string): Promise<{ doc: PdfDoc; OPS: Record<string, number>; close: () => Promise<void> }> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const data = new Uint8Array(await fs.readFile(filePath));
	const task = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const doc = (await task.promise) as unknown as PdfDoc;
	// Teardown is the loading task's destroy() (the pdf-ops idiom), not the document's.
	return { doc, OPS: pdfjs.OPS as unknown as Record<string, number>, close: () => task.destroy().catch(() => undefined) };
}

/** A page's text with its own line breaks. */
function pageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
	let out = "";
	for (const item of items) {
		if (typeof item.str !== "string") continue;
		out += item.str;
		if (item.hasEOL) out += "\n";
	}
	return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function resolveOutline(doc: PdfDoc, items: OutlineItem[] | null, depth: number, out: RawOutlineEntry[]): Promise<void> {
	for (const item of items ?? []) {
		try {
			let dest = item.dest;
			if (typeof dest === "string") dest = await doc.getDestination(dest);
			if (Array.isArray(dest) && dest.length > 0) {
				const ref = dest[0];
				const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref);
				out.push({ title: item.title, page: index + 1, depth });
			}
		} catch {
			// an entry whose target can't be resolved is skipped, never guessed
		}
		await resolveOutline(doc, item.items ?? null, depth + 1, out);
	}
}

/** Read a whole book once. `onProgress` fires about every 25 pages. */
export async function extractBook(filePath: string, onProgress?: (done: number, total: number) => void): Promise<ExtractedBook> {
	const { doc, OPS, close } = await openDoc(filePath);
	try {
		const pages: ExtractedPage[] = [];
		for (let p = 1; p <= doc.numPages; p++) {
			const page = await doc.getPage(p);
			const content = await page.getTextContent();
			const ops = await page.getOperatorList();
			let images = 0;
			for (const fn of ops.fnArray) if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) images++;
			pages.push({ p, text: pageText(content.items), images });
			page.cleanup();
			if (onProgress && p % 25 === 0) onProgress(p, doc.numPages);
		}
		const outline: RawOutlineEntry[] = [];
		await resolveOutline(doc, await doc.getOutline().catch(() => null), 0, outline);
		const labels = await doc.getPageLabels().catch(() => null);
		const meta = await doc.getMetadata().catch(() => null);
		const title = typeof meta?.info?.Title === "string" && meta.info.Title.trim() !== "" ? meta.info.Title.trim() : null;
		return { pageCount: doc.numPages, title, pages, outline, labels: labels && labels.length === doc.numPages ? labels : null };
	} finally {
		await close();
	}
}

/** A short document read as LINES, one `=== PAGE n ===` marker per page — the
 *  form the roadmap parser reads (it needs line structure, which a page-text
 *  blob would lose). Lines are grouped by their vertical position. */
export async function extractLines(filePath: string): Promise<string> {
	const { doc, close } = await openDoc(filePath);
	try {
		const out: string[] = [];
		for (let p = 1; p <= doc.numPages; p++) {
			const page = await doc.getPage(p);
			const content = await page.getTextContent();
			out.push(`=== PAGE ${p} ===`);
			let lastY: number | null = null;
			let line = "";
			for (const item of content.items) {
				if (typeof item.str !== "string") continue;
				const y = Math.round(item.transform?.[5] ?? 0);
				if (lastY !== null && Math.abs(y - lastY) > 2) {
					out.push(line);
					line = "";
				}
				line += item.str;
				lastY = y;
			}
			out.push(line);
			page.cleanup();
		}
		return out.join("\n");
	} finally {
		await close();
	}
}
