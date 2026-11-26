/**
 * Book index logic — pure, browser-safe, no IO.
 *
 *  - outline → page spans (each table-of-contents entry covers its pages)
 *  - printed page numbers (PDF labels when present, else a detected offset)
 *  - a garbled-formula detector (the page should be looked at, not trusted)
 *  - keyword search (BM25 over pages) with citation-ready hits
 *  - page-range clamping for the retrieval tools' hard caps
 */

import type { BookHit, BookManifest, BookOutlineNode } from "./contracts/books.ts";

// ─── outline → spans ─────────────────────────────────────────────────────────

/** Entries as read from the PDF (page = 1-based PDF page, depth 0 = top). */
export interface RawOutlineEntry {
	title: string;
	page: number;
	depth: number;
}

/** Turn raw outline entries into spans. Entries pointing at no page are dropped;
 *  an entry's span ends before the next entry of the same or shallower depth
 *  (or at the last page); a span never ends before it starts. */
export function outlineSpans(entries: readonly RawOutlineEntry[], pageCount: number): BookOutlineNode[] {
	const kept = entries.filter((e) => Number.isInteger(e.page) && e.page >= 1 && e.page <= pageCount && e.title.trim() !== "");
	return kept.map((entry, i) => {
		let end = pageCount;
		for (let j = i + 1; j < kept.length; j++) {
			if (kept[j]!.depth <= entry.depth) {
				end = Math.max(entry.page, kept[j]!.page - 1);
				// Two siblings on the same page: the first one covers just that page.
				if (kept[j]!.page === entry.page) end = entry.page;
				break;
			}
		}
		return { id: `o${i + 1}`, title: entry.title.trim().replace(/\s+/g, " "), depth: entry.depth, startPage: entry.page, endPage: Math.max(entry.page, end) };
	});
}

// ─── printed page numbers ────────────────────────────────────────────────────

const LEADING_NUMBER = /^\d{1,4}/;
const TRAILING_NUMBER = /\d{1,4}$/;
const EDGE_TOKENS = 10;

/** Detect printed-page numbering from page texts (index 0 = PDF page 1): the
 *  running header/footer number sits in the first or last few tokens of a page,
 *  so PDF page − that number should be the same offset on every page. The most
 *  common offset wins if enough pages agree; otherwise null (never a guess). */
export function detectPageOffset(pageTexts: readonly string[]): { offset: number | null; confidence: number } {
	const n = pageTexts.length;
	if (n < 20) return { offset: null, confidence: 0 };
	const from = Math.floor(n * 0.15);
	const to = Math.floor(n * 0.85);
	const votes = new Map<number, number>();
	let considered = 0;
	for (let i = from; i < to; i++) {
		const tokens = pageTexts[i]!.split(/\s+/).filter(Boolean);
		const edge = [...tokens.slice(0, EDGE_TOKENS), ...tokens.slice(-EDGE_TOKENS)];
		const seen = new Set<number>();
		for (const token of edge) {
			// A running header's number is often glued to its neighbour in the
			// extracted text ("industry264", "265CHAPTER"), so take digits at either end.
			for (const digits of [token.match(LEADING_NUMBER)?.[0], token.match(TRAILING_NUMBER)?.[0]]) {
				if (digits === undefined) continue;
				const printed = Number(digits);
				const offset = i + 1 - printed;
				if (printed >= 1 && offset >= 0 && offset <= 200) seen.add(offset);
			}
		}
		considered++;
		for (const offset of seen) votes.set(offset, (votes.get(offset) ?? 0) + 1);
	}
	const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
	const best = ranked[0];
	if (!best || considered === 0) return { offset: null, confidence: 0 };
	const confidence = best[1] / considered;
	const runnerUp = ranked[1]?.[1] ?? 0;
	if (confidence < 0.4 || best[1] < runnerUp * 1.5) return { offset: null, confidence };
	return { offset: best[0], confidence };
}

/** The number printed on PDF page `p`, or null when unknown / in the front matter. */
export function printedPage(book: Pick<BookManifest, "labels" | "pageOffset">, p: number): string | null {
	if (book.labels) {
		const label = book.labels[p - 1];
		return label && /^\d+$/.test(label) ? label : null;
	}
	if (book.pageOffset !== null && p - book.pageOffset >= 1) return String(p - book.pageOffset);
	return null;
}

/** "p. 603 (PDF 629)" — the citation form every tool prints. */
export function pageCitation(book: Pick<BookManifest, "labels" | "pageOffset">, p: number): string {
	const printed = printedPage(book, p);
	return printed ? `p. ${printed} (PDF ${p})` : `PDF ${p}`;
}

// ─── matching a roadmap's book label to an ingested book ────────────────────

/** Does a roadmap's label for a book ("Mankiw", "Berk & DeMarzo") name this
 *  file? Every word of the label must appear in the file name or PDF title. */
export function matchesBookLabel(label: string, book: Pick<BookManifest, "sourceName" | "title">): boolean {
	const words = label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "" && w !== "and");
	const haystack = `${book.sourceName} ${book.title ?? ""}`.toLowerCase();
	return words.length > 0 && words.every((w) => haystack.includes(w));
}

// ─── garbled text ────────────────────────────────────────────────────────────

/** Symbol-font mapping defects (Hull style: ¼ for =, þ for +, ð/Þ for
 *  parentheses, "ffiffiffiffi" for a root sign) and private-use / replacement
 *  characters. Six or more on a page means its formulas can't be trusted. */
const GARBLE = /[¼þðÞ]|ffiffi|[-�]/g;
export const GARBLE_THRESHOLD = 6;

export function isGarbled(text: string): boolean {
	return (text.match(GARBLE)?.length ?? 0) >= GARBLE_THRESHOLD;
}

// ─── retrieval caps ──────────────────────────────────────────────────────────

/** Hard ceilings for ONE get_pages call — enforced in code, never by prompt. */
export const MAX_PAGES_PER_CALL = 8;
export const MAX_CHARS_PER_CALL = 30_000;
export const MAX_IMAGES_PER_CALL = 3;
export const MAX_SEARCH_HITS = 8;

/** Clamp a requested inclusive range to the book and the page cap. */
export function clampRange(start: number, end: number, pageCount: number, max: number = MAX_PAGES_PER_CALL): { start: number; end: number; clipped: boolean } | null {
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	const lo = Math.max(1, Math.min(start, end));
	const hi = Math.min(pageCount, Math.max(start, end));
	if (lo > pageCount || hi < 1) return null;
	const capped = Math.min(hi, lo + max - 1);
	return { start: lo, end: capped, clipped: capped < hi || lo !== Math.min(start, end) };
}

// ─── keyword search (BM25 over pages) ────────────────────────────────────────

const STOPWORDS = new Set(
	"a an and are as at be by for from has have in is it its of on or that the this to was were will with which not but can may also than then there these those their they them into such more most other some any each both".split(" "),
);

export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const K1 = 1.2;
const B = 0.75;

/** A BM25 index over one book's pages (doc i = PDF page i+1). Built in memory
 *  from the saved page text — about 1,000 pages take a few milliseconds. */
export class PageSearchIndex {
	private readonly docs: Map<string, number>[];
	private readonly lengths: number[];
	private readonly df = new Map<string, number>();
	private readonly avgLen: number;

	constructor(private readonly pageTexts: readonly string[]) {
		this.docs = pageTexts.map((text) => {
			const tf = new Map<string, number>();
			for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + 1);
			return tf;
		});
		this.lengths = this.docs.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
		for (const tf of this.docs) for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
		this.avgLen = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
	}

	/** Best pages for the query, highest score first. Terms that appear on no
	 *  page are ignored; a query with no known term returns nothing. */
	search(query: string, limit: number = MAX_SEARCH_HITS): { page: number; score: number; snippet: string }[] {
		const terms = [...new Set(tokenize(query))];
		const n = this.docs.length;
		const scored: { page: number; score: number }[] = [];
		for (let i = 0; i < n; i++) {
			let score = 0;
			for (const term of terms) {
				const tf = this.docs[i]!.get(term);
				if (!tf) continue;
				const df = this.df.get(term) ?? 0;
				const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
				score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * this.lengths[i]!) / this.avgLen));
			}
			if (score > 0) scored.push({ page: i + 1, score });
		}
		scored.sort((a, b) => b.score - a.score || a.page - b.page);
		return scored.slice(0, limit).map((hit) => ({ ...hit, snippet: snippetAround(this.pageTexts[hit.page - 1]!, terms) }));
	}
}

/** ~240 characters around the first query term found in the page. */
export function snippetAround(text: string, terms: readonly string[]): string {
	const flat = text.replace(/\s+/g, " ");
	const lower = flat.toLowerCase();
	let at = -1;
	for (const term of terms) {
		const i = lower.indexOf(term);
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	if (at < 0) return flat.slice(0, 240);
	const start = Math.max(0, at - 100);
	return (start > 0 ? "…" : "") + flat.slice(start, start + 240) + (start + 240 < flat.length ? "…" : "");
}

/** Combine per-book hits into one ranked list (scores are comparable enough
 *  across books for an ordering; the caller labels each hit with its book). */
export function mergeHits(hits: readonly BookHit[], limit: number = MAX_SEARCH_HITS): BookHit[] {
	return [...hits].sort((a, b) => b.score - a.score).slice(0, limit);
}
