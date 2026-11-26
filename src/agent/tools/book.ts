import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import {
	MAX_CHARS_PER_CALL,
	MAX_IMAGES_PER_CALL,
	MAX_PAGES_PER_CALL,
	MAX_SEARCH_HITS,
	clampRange,
	pageCitation,
} from "../../core/book-index.ts";
import type { BookHit, BookManifest, BookOutlineNode } from "../../core/contracts/books.ts";

/**
 * The retrieval tools — the ONLY way a roadmap session touches the books.
 *
 * The books are read once at ingest and saved as an index; these tools serve
 * pages from that saved index. Nothing here opens a PDF to read text, and no
 * call can return a whole book: every cap below is enforced in code, never
 * left to the prompt.
 *
 *   book_outline  the table of contents with page spans (find where to look)
 *   search_books  keyword search → cited hits with a snippet (no page loaded)
 *   get_pages     the saved text of a few pages, each headed with its citation
 *   see_pages     page IMAGES, for pages whose text is unreliable (garbled
 *                 formulas) or whose figures matter
 *
 * Pages are the PDF's own 1-based page numbers (what the roadmap lists); every
 * result also prints the number printed in the book, which is what to cite.
 *
 * Tool contract (the web.ts law): never throw into the agent loop for a bad
 * request — return a clear error STRING the model can adapt to.
 */

/** What the tools need from the folder's saved books (the server implements it
 *  over the book store; tests pass a fake). The agent layer never imports a store. */
export interface BookReader {
	books(): BookManifest[];
	outline(bookId: string): BookOutlineNode[];
	/** Saved text for PDF pages start..end (inclusive, already clamped). */
	pages(bookId: string, start: number, end: number): { p: number; text: string; img: number; bad: boolean }[];
	search(query: string, bookId: string | null, limit: number): BookHit[];
	/** Rendered page images (PNG), for see_pages. */
	render(bookId: string, pages: number[]): Promise<{ page: number; png: Buffer }[]>;
}

/** Name a book the way the tools and citations do: its roadmap key when it
 *  has one, else the first part of its file name. */
export function bookLabel(book: Pick<BookManifest, "key" | "title" | "sourceName">): string {
	return book.key ?? book.sourceName.split(" -- ")[0]!.replace(/\.pdf$/i, "").trim();
}

/** Find the book a call names: by key, id, or any part of its title/file name.
 *  Returns the book, or an error string listing what exists. */
export function resolveBook(books: readonly BookManifest[], name: string): BookManifest | string {
	const wanted = name.trim().toLowerCase();
	const list = books.map((b) => `"${bookLabel(b)}"`).join(", ") || "none yet";
	if (wanted === "") return `Name the book. Books in this folder: ${list}.`;
	const exact = books.filter((b) => b.key?.toLowerCase() === wanted || b.id.toLowerCase() === wanted);
	if (exact.length === 1) return exact[0]!;
	const partial = books.filter((b) => `${b.key ?? ""} ${b.title ?? ""} ${b.sourceName}`.toLowerCase().includes(wanted));
	if (partial.length === 1) return partial[0]!;
	if (partial.length === 0) return `No book matches "${name}". Books in this folder: ${list}.`;
	return `"${name}" matches more than one book (${partial.map((b) => `"${bookLabel(b)}"`).join(", ")}). Use a more specific name.`;
}

const bookArg = Type.String({ description: "The book: its short name from the roadmap (e.g. the author's surname) or part of its title." });

const outlineInput = Type.Object({
	book: bookArg,
	depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "How deep to list: 0 = top-level entries only (parts or chapters), 1 = one level down (default), 2 = sections, and so on." })),
	from_page: Type.Optional(Type.Integer({ minimum: 1, description: "Only entries that overlap this PDF page or later." })),
	to_page: Type.Optional(Type.Integer({ minimum: 1, description: "Only entries that start on or before this PDF page." })),
});

const searchInput = Type.Object({
	query: Type.String({ minLength: 2, description: "Words to look for (keywords, not a sentence)." }),
	book: Type.Optional(Type.String({ description: "Limit the search to one book; omit to search them all." })),
});

const pagesInput = Type.Object({
	book: bookArg,
	start: Type.Integer({ minimum: 1, description: `First PDF page to read.` }),
	end: Type.Integer({ minimum: 1, description: `Last PDF page to read (at most ${MAX_PAGES_PER_CALL} pages per call).` }),
});

const seeInput = Type.Object({
	book: bookArg,
	pages: Type.String({ description: `PDF pages to view as images: "629", "629-631" or "629,633" (at most ${MAX_IMAGES_PER_CALL}).` }),
});

/** Parse "629", "629-631", "629,633" into a sorted unique list (no clamping). */
export function parsePages(spec: string): number[] {
	const out = new Set<number>();
	for (const part of spec.split(",")) {
		const m = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
		if (!m) continue;
		const a = Number(m[1]);
		const b = m[2] ? Number(m[2]) : a;
		for (let p = Math.min(a, b); p <= Math.max(a, b) && out.size < 1000; p++) out.add(p);
	}
	return [...out].sort((x, y) => x - y);
}

export function bookTools(reader: BookReader): Record<string, AgentTool<any>> {
	const withBook = <T>(name: string, fn: (book: BookManifest) => T): T | string => {
		const found = resolveBook(reader.books(), name);
		return typeof found === "string" ? found : fn(found);
	};

	return {
		book_outline: {
			name: "book_outline",
			label: "book_outline",
			description:
				"List a book's table of contents with the PDF page span of each entry (and the printed page numbers). Use it to find which pages a chapter or section covers. " +
				"Returns at most 80 entries; narrow with from_page / to_page or raise depth to see sections.",
			parameters: outlineInput,
			execute: serverExecute("book_outline", outlineInput, ({ book, depth, from_page, to_page }) =>
				withBook(book, (b) => {
					const maxDepth = depth ?? 1;
					const rows = reader
						.outline(b.id)
						.filter((n) => n.depth <= maxDepth)
						.filter((n) => (from_page === undefined || n.endPage >= from_page) && (to_page === undefined || n.startPage <= to_page));
					if (rows.length === 0) return `${bookLabel(b)} has no outline entries for that selection${reader.outline(b.id).length === 0 ? " (this book has no table of contents saved — use search_books)" : ""}.`;
					const shown = rows.slice(0, 80);
					const lines = shown.map((n) => `${"  ".repeat(n.depth)}${n.title} — ${pageCitation(b, n.startPage)}${n.endPage > n.startPage ? ` to ${pageCitation(b, n.endPage)}` : ""}`);
					return `${bookLabel(b)} — ${b.pages} PDF pages\n${lines.join("\n")}${rows.length > shown.length ? `\n… ${rows.length - shown.length} more entries; narrow with from_page / to_page.` : ""}`;
				}),
			),
		},

		search_books: {
			name: "search_books",
			label: "search_books",
			description:
				`Keyword search over the saved pages of the folder's books. Returns up to ${MAX_SEARCH_HITS} best pages with a short snippet and the page citation — it does NOT load pages. ` +
				"Follow up with get_pages on the pages worth reading.",
			parameters: searchInput,
			execute: serverExecute("search_books", searchInput, ({ query, book }) => {
				let bookId: string | null = null;
				if (book !== undefined && book.trim() !== "") {
					const found = resolveBook(reader.books(), book);
					if (typeof found === "string") return found;
					bookId = found.id;
				}
				const hits = reader.search(query, bookId, MAX_SEARCH_HITS);
				if (hits.length === 0) return `No pages match "${query}". Try other keywords (the book's own terms).`;
				return hits
					.map((h) => {
						const b = reader.books().find((x) => x.id === h.book);
						return `${b ? bookLabel(b) : h.book} ${h.printed ? `p. ${h.printed} (PDF ${h.page})` : `PDF ${h.page}`}: ${h.snippet}`;
					})
					.join("\n");
			}),
		},

		get_pages: {
			name: "get_pages",
			label: "get_pages",
			description:
				`Read the saved text of PDF pages start..end of one book (at most ${MAX_PAGES_PER_CALL} pages and about ${Math.round(MAX_CHARS_PER_CALL / 1000)}k characters per call — ask again for the next pages). ` +
				"Each page is headed with its citation. Pages flagged as garbled have unreliable formulas: look at them with see_pages before using any formula from them.",
			parameters: pagesInput,
			execute: serverExecute("get_pages", pagesInput, ({ book, start, end }) =>
				withBook(book, (b) => {
					const range = clampRange(start, end, b.pages, MAX_PAGES_PER_CALL);
					if (!range) return `${bookLabel(b)} has ${b.pages} pages; PDF pages ${start}–${end} are outside it.`;
					const rows = reader.pages(b.id, range.start, range.end);
					const parts: string[] = [];
					let used = 0;
					let lastShown = range.start - 1;
					for (const row of rows) {
						const body = row.text.trim() === "" ? "(no text on this page)" : row.text;
						if (parts.length > 0 && used + body.length > MAX_CHARS_PER_CALL) break;
						const flags = [row.bad ? "garbled formulas — use see_pages" : "", row.img > 0 ? "has figures" : ""].filter(Boolean);
						parts.push(`--- [${bookLabel(b)} ${pageCitation(b, row.p)}]${flags.length ? ` ⚠ ${flags.join("; ")}` : ""} ---\n${body}`);
						used += body.length;
						lastShown = row.p;
					}
					const asked = Math.abs(end - start) + 1;
					const notes: string[] = [];
					if (lastShown < Math.max(start, end)) notes.push(`Returned PDF pages ${range.start}–${lastShown} of the ${asked} you asked for. Call again with start=${lastShown + 1} for the rest.`);
					return `${notes.join(" ")}${notes.length ? "\n\n" : ""}${parts.join("\n\n")}`;
				}),
			),
		},

		see_pages: {
			name: "see_pages",
			label: "see_pages",
			description:
				`View PDF pages as images (at most ${MAX_IMAGES_PER_CALL} per call). Use it for pages flagged as garbled, and when a graph or figure matters. Needs a model that can see images.`,
			parameters: seeInput,
			execute: serverExecute("see_pages", seeInput, async ({ book, pages }): Promise<ImageFileResult | string> => {
				const found = resolveBook(reader.books(), book);
				if (typeof found === "string") return found;
				const wanted = parsePages(pages).filter((p) => p >= 1 && p <= found.pages);
				if (wanted.length === 0) return `No valid pages in "${pages}" (${bookLabel(found)} has ${found.pages} pages).`;
				const taken = wanted.slice(0, MAX_IMAGES_PER_CALL);
				const rendered = await reader.render(found.id, taken);
				const cites = rendered.map((r) => `image ${rendered.indexOf(r) + 1} = ${bookLabel(found)} ${pageCitation(found, r.page)}`);
				return {
					text: `${cites.join("; ")}.${wanted.length > taken.length ? ` Only the first ${taken.length} of ${wanted.length} requested pages were rendered.` : ""}`,
					images: rendered.map((r) => ({ data: r.png.toString("base64"), mimeType: "image/png" })),
					details: { book: found.id, pages: rendered.map((r) => r.page) },
				};
			}),
		},
	};
}
