import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractBook } from "../agent/books/pdf-extract.ts";
import type { BookReader } from "../agent/tools/book.ts";
import { providerSafePng, realHeadless } from "../agent/subagents/headless.ts";
import { PageSearchIndex, detectPageOffset, isGarbled, matchesBookLabel, outlineSpans, printedPage } from "../core/book-index.ts";
import { BOOK_FORMAT_VERSION, type BookHit, type BookManifest, type BookPage } from "../core/contracts/books.ts";
import { normalizeFolderName, sameFolder } from "../core/organize.ts";
import { stores } from "./stores.ts";

/**
 * A ROADMAP FOLDER'S BOOKS, server side: the one-time ingest (read the PDF,
 * save its pages, outline and numbering as an index) and the BookReader the
 * retrieval tools run on. A book is identified by the SHA-256 of its file, so
 * adding the same file again is a no-op — nothing is ever re-read.
 *
 * Results are HTTP-shaped like server/library.ts, so routes stay thin.
 */

export type BookResult<T extends object = object> =
	| ({ ok: true } & T)
	| { ok: false; status: 400 | 404 | 409 | 422; code: string; error: string };

const fail = (status: 400 | 404 | 409 | 422, code: string, error: string): BookResult<never> => ({ ok: false, status, code, error });

const MAX_BOOK_BYTES = 1024 * 1024 * 1024;

/** The roadmap folder's id, or an HTTP-shaped refusal. */
export function roadmapFolderId(rawName: unknown): { folderId: string } | Extract<BookResult, { ok: false }> {
	const name = normalizeFolderName(rawName);
	if (!name) return fail(400, "bad_name", "Folder name is required.");
	const folder = stores.libraryStore.view().folders.find((f) => sameFolder(f, name));
	if (!folder) return fail(404, "not_found", "No such folder.");
	const meta = stores.libraryStore.getFolderMeta(folder);
	if (meta?.type !== "roadmap") return fail(409, "not_roadmap", `"${folder}" is not a roadmap folder.`);
	return { folderId: meta.id };
}

function sha256Of(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		fs.createReadStream(file)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

export function listBooks(rawFolder: unknown): BookResult<{ books: BookManifest[] }> {
	const folder = roadmapFolderId(rawFolder);
	if (!("folderId" in folder)) return folder;
	return { ok: true, books: stores.bookStore.list(folder.folderId) };
}

/** Add one PDF (by its absolute path on this machine) to the folder's books.
 *  Reads it once; an already-added file (same SHA-256) is returned untouched. */
export async function addBook(rawFolder: unknown, rawPath: unknown, opts: { displayName?: string } = {}): Promise<BookResult<{ book: BookManifest; existed: boolean }>> {
	const folder = roadmapFolderId(rawFolder);
	if (!("folderId" in folder)) return folder;
	if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) return fail(400, "bad_path", "Give the book's full file path.");
	if (path.extname(rawPath).toLowerCase() !== ".pdf") return fail(400, "not_pdf", "Only PDF books can be added.");
	let stat: fs.Stats;
	try {
		stat = fs.statSync(rawPath);
	} catch {
		return fail(404, "no_file", "That file doesn't exist.");
	}
	if (!stat.isFile()) return fail(400, "not_file", "That path is not a file.");
	if (stat.size > MAX_BOOK_BYTES) return fail(400, "too_big", "That file is over 1 GB.");

	const sha256 = await sha256Of(rawPath);
	const id = `b_${sha256.slice(0, 12)}`;
	const existing = stores.bookStore.readManifest(folder.folderId, id);
	if (existing) {
		assignBookKeys(folder.folderId);
		return { ok: true, book: stores.bookStore.readManifest(folder.folderId, id) ?? existing, existed: true };
	}

	let extracted;
	try {
		extracted = await extractBook(rawPath);
	} catch (error) {
		return fail(422, "unreadable", `Could not read that PDF: ${error instanceof Error ? error.message : "unknown error"}.`);
	}
	const pages: BookPage[] = extracted.pages.map((p) => ({ p: p.p, text: p.text, img: p.images, ...(isGarbled(p.text) ? { bad: true } : {}) }));
	const detected = extracted.labels ? { offset: null, confidence: 1 } : detectPageOffset(pages.map((p) => p.text));
	const manifest: BookManifest = {
		version: BOOK_FORMAT_VERSION,
		id,
		sourceName: opts.displayName ?? path.basename(rawPath),
		title: extracted.title,
		sha256,
		bytes: stat.size,
		pages: extracted.pageCount,
		indexedAt: new Date().toISOString(),
		pageOffset: detected.offset,
		offsetConfidence: Math.round(detected.confidence * 100) / 100,
		labels: extracted.labels,
		outlineEntries: extracted.outline.length,
		badPages: pages.filter((p) => p.bad).map((p) => p.p),
		figurePages: pages.filter((p) => p.img > 0).length,
	};
	stores.bookStore.write(folder.folderId, { manifest, outline: outlineSpans(extracted.outline, extracted.pageCount), pages, sourcePdf: rawPath });
	assignBookKeys(folder.folderId);
	return { ok: true, book: stores.bookStore.readManifest(folder.folderId, id) ?? manifest, existed: false };
}

/** Give each added book the short key its roadmap uses ("mankiw"), by matching
 *  the roadmap's label to the file's name/title. A label that fits exactly one
 *  book sets that book's key; none or several leave keys alone (the setup
 *  screen reports it). Safe to call any time: after a roadmap import, after a
 *  book is added. */
export function assignBookKeys(folderId: string): void {
	const labels = stores.roadmapStore.readRoadmap(folderId)?.books ?? [];
	if (labels.length === 0) return;
	const books = stores.bookStore.list(folderId);
	for (const { label, key } of labels) {
		const fits = books.filter((b) => matchesBookLabel(label, b));
		if (fits.length === 1 && fits[0]!.key !== key) stores.bookStore.patchManifest(folderId, fits[0]!.id, { key });
	}
}

/** Add a book from an uploaded stream (the setup screen's file picker): written
 *  to a temporary file under its own name, ingested, then the temp copy is gone. */
export async function addUploadedBook(rawFolder: unknown, rawName: unknown, body: ReadableStream<Uint8Array> | null): Promise<BookResult<{ book: BookManifest; existed: boolean }>> {
	const folder = roadmapFolderId(rawFolder);
	if (!("folderId" in folder)) return folder;
	const name = typeof rawName === "string" ? path.basename(rawName).replace(/[^\p{L}\p{N}._ ()\[\]&,'-]+/gu, "_").trim() : "";
	if (name === "" || path.extname(name).toLowerCase() !== ".pdf") return fail(400, "not_pdf", "Only PDF books can be added.");
	if (!body) return fail(400, "no_body", "No file was sent.");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-"));
	try {
		const target = path.join(dir, name);
		let bytes = 0;
		const out = fs.createWriteStream(target);
		const limit = new Transform({
			transform(chunk: Buffer, _enc, cb) {
				bytes += chunk.length;
				cb(bytes > MAX_BOOK_BYTES ? new Error("over 1 GB") : null, chunk);
			},
		});
		try {
			await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), limit, out);
		} catch (error) {
			return fail(400, "upload_failed", `The upload did not finish: ${error instanceof Error ? error.message : "unknown error"}.`);
		}
		return await addBook(rawFolder, target, { displayName: name });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const searchIndexes = new WeakMap<BookPage[], PageSearchIndex>();

/** The retrieval tools' window onto one roadmap folder's saved books. */
export function bookReaderFor(folderId: string): BookReader {
	const manifestOf = (bookId: string): BookManifest => {
		const manifest = stores.bookStore.readManifest(folderId, bookId);
		if (!manifest) throw new Error(`Unknown book ${bookId}`);
		return manifest;
	};
	return {
		books: () => stores.bookStore.list(folderId),
		outline: (bookId) => stores.bookStore.readOutline(folderId, bookId),
		pages: (bookId, start, end) =>
			stores.bookStore
				.readPages(folderId, bookId)
				.filter((p) => p.p >= start && p.p <= end)
				.map((p) => ({ p: p.p, text: p.text, img: p.img, bad: p.bad === true })),
		search: (query, bookId, limit) => {
			const books = bookId ? [manifestOf(bookId)] : stores.bookStore.list(folderId);
			const hits: BookHit[] = [];
			for (const book of books) {
				const pages = stores.bookStore.readPages(folderId, book.id);
				let index = searchIndexes.get(pages);
				if (!index) {
					index = new PageSearchIndex(pages.map((p) => p.text));
					searchIndexes.set(pages, index);
				}
				for (const hit of index.search(query, limit)) hits.push({ book: book.id, page: hit.page, printed: printedPage(book, hit.page), score: hit.score, snippet: hit.snippet });
			}
			return hits.sort((a, b) => b.score - a.score).slice(0, limit);
		},
		render: async (bookId, pages) => {
			const rendered = await realHeadless.renderPdfPages(stores.bookStore.sourcePath(folderId, bookId), pages, { dpi: 110 });
			return rendered.map((r) => ({ page: r.page, png: providerSafePng(r.png) }));
		},
	};
}
