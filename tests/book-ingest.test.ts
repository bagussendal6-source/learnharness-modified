/**
 * Book ingest + the retrieval tools, against the committed 3-page fixture:
 * read once, saved as an index, never re-read; every cap enforced in code.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-books-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { createFolder } = await import("../src/server/library.ts");
const { makeRoadmapFolder } = await import("../src/server/roadmap.ts");
const { addBook, bookReaderFor, listBooks } = await import("../src/server/books.ts");
const { bookTools, parsePages, resolveBook } = await import("../src/agent/tools/book.ts");
const { libraryStore } = await import("../src/store/library.ts");

test.after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const text = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

createFolder("Ekonomi");
createFolder("Biasa");
makeRoadmapFolder("Ekonomi");

test("only a roadmap folder takes books; bad paths are refused with a reason", async () => {
	assert.deepEqual(await addBook("Biasa", FIXTURE).then((r) => (r.ok ? null : r.code)), "not_roadmap");
	assert.equal((await addBook("Ghost", FIXTURE).then((r) => (r.ok ? null : r.code))), "not_found");
	assert.equal((await addBook("Ekonomi", "relative.pdf").then((r) => (r.ok ? null : r.code))), "bad_path");
	assert.equal((await addBook("Ekonomi", "/nope/missing.pdf").then((r) => (r.ok ? null : r.code))), "no_file");
	assert.equal((await addBook("Ekonomi", path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt")).then((r) => (r.ok ? null : r.code))), "not_pdf");
});

test("ingest reads the book once, saves the index, and a repeat is a no-op", async () => {
	const first = await addBook("Ekonomi", FIXTURE);
	assert.ok(first.ok && !first.existed);
	assert.equal(first.book.pages, 3);
	assert.equal(first.book.sourceName, "sample-3page.pdf");
	assert.equal(first.book.pageOffset, null, "a 3-page file has no detectable numbering — never a guess");
	const again = await addBook("Ekonomi", FIXTURE);
	assert.ok(again.ok && again.existed);
	assert.equal(again.book.id, first.book.id);
	const listed = listBooks("Ekonomi");
	assert.ok(listed.ok && listed.books.length === 1);
	const folderId = libraryStore.getFolderMeta("Ekonomi")!.id;
	for (const f of ["manifest.json", "outline.json", "pages.json", "source.pdf"]) {
		assert.ok(fs.existsSync(path.join(TMP_DATA, "roadmaps", folderId, "books", first.book.id, f)), f);
	}
});

test("get_pages: cited pages from the saved index; unknown book / range are readable errors", async () => {
	const tools = bookTools(bookReaderFor(libraryStore.getFolderMeta("Ekonomi")!.id)) as Record<string, { execute: (id: string, input: object) => Promise<{ content: { type: string; text?: string }[] }> }>;
	const two = text(await tools.get_pages!.execute("1", { book: "sample", start: 1, end: 2 }));
	assert.match(two, /--- \[sample-3page PDF 1\] ---/);
	assert.match(two, /Calculus/);
	assert.match(two, /--- \[sample-3page PDF 2\] ---/);
	assert.ok(!two.includes("PDF 3]"));
	assert.match(text(await tools.get_pages!.execute("2", { book: "nope", start: 1, end: 2 })), /No book matches "nope"\. Books in this folder: "sample-3page"/);
	assert.match(text(await tools.get_pages!.execute("3", { book: "sample", start: 40, end: 42 })), /has 3 pages; PDF pages 40–42 are outside it/);
});

test("search_books: cited hits with a snippet, no page loaded", async () => {
	const tools = bookTools(bookReaderFor(libraryStore.getFolderMeta("Ekonomi")!.id)) as Record<string, { execute: (id: string, input: object) => Promise<{ content: { type: string; text?: string }[] }> }>;
	const hit = text(await tools.search_books!.execute("1", { query: "force" }));
	assert.match(hit, /^sample-3page PDF 2: /);
	assert.match(text(await tools.search_books!.execute("2", { query: "zymurgy" })), /No pages match "zymurgy"/);
	assert.match(text(await tools.book_outline!.execute("3", { book: "sample" })), /no table of contents saved/);
});

test("the page cap is enforced in code (and says how to get the rest)", async () => {
	const many = Array.from({ length: 20 }, (_, i) => ({ p: i + 1, text: `page ${i + 1} text`, img: 0, bad: i === 4 }));
	const book = { version: 1, id: "b_x", sourceName: "Big.pdf", title: null, sha256: "x", bytes: 1, pages: 20, indexedAt: "", pageOffset: 2, offsetConfidence: 1, labels: null, outlineEntries: 0, badPages: [5], figurePages: 0 };
	const tools = bookTools({
		books: () => [book],
		outline: () => [],
		pages: (_id, s, e) => many.filter((p) => p.p >= s && p.p <= e),
		search: () => [],
		render: async () => [],
	}) as Record<string, { execute: (id: string, input: object) => Promise<{ content: { type: string; text?: string }[] }> }>;
	const out = text(await tools.get_pages!.execute("1", { book: "big", start: 1, end: 20 }));
	assert.equal((out.match(/--- \[/g) ?? []).length, 8, "never more than 8 pages in one call");
	assert.match(out, /Returned PDF pages 1–8 of the 20 you asked for\. Call again with start=9/);
	assert.match(out, /--- \[Big p\. 3 \(PDF 5\)\] ⚠ garbled formulas — use see_pages ---/);
	assert.match(text(await tools.see_pages!.execute("2", { book: "big", pages: "1-9" })), /Only the first 3 of 9 requested pages were rendered/);
});

test("resolveBook + parsePages", () => {
	const b = (id: string, sourceName: string, key?: string) => ({ version: 1, id, key, sourceName, title: null, sha256: "", bytes: 0, pages: 9, indexedAt: "", pageOffset: null, offsetConfidence: 0, labels: null, outlineEntries: 0, badPages: [], figurePages: 0 });
	const books = [b("b_1", "Corporate Finance -- Berk.pdf"), b("b_2", "Corporate Law -- X.pdf", "law")];
	assert.equal((resolveBook(books, "law") as { id: string }).id, "b_2");
	assert.equal((resolveBook(books, "finance") as { id: string }).id, "b_1");
	assert.match(resolveBook(books, "corporate") as string, /more than one book/);
	assert.deepEqual(parsePages("629, 631-633, 631"), [629, 631, 632, 633]);
});
