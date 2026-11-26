/**
 * Book store — the fs adapter for a roadmap folder's ingested books
 * (data/roadmaps/<folderId>/books/<bookId>/). Implements core/ports.ts BookStore.
 *
 *   manifest.json   what the book is (core/contracts/books.ts BookManifest)
 *   outline.json    the table-of-contents tree with page spans
 *   pages.json      every page's saved text — the ONLY thing sessions read
 *   source.pdf      the PDF copy (kept for rendering page images)
 *
 * Written once at ingest, read-only afterwards. pages.json is cached in memory
 * per book (about 3 MB for a 900-page book) and re-read when the file changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BOOK_FORMAT_VERSION, type BookManifest, type BookOutlineNode, type BookPage } from "../core/contracts/books.ts";
import type { BookStore } from "../core/ports.ts";
import { roadmapDir } from "./roadmap.ts";

function bookDir(folderId: string, bookId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(bookId)) throw new Error(`Invalid book id: ${bookId}`);
	return path.join(roadmapDir(folderId), "books", bookId);
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

function readManifest(folderId: string, bookId: string): BookManifest | null {
	let manifest: BookManifest | null;
	try {
		manifest = readJson<BookManifest>(path.join(bookDir(folderId, bookId), "manifest.json"));
	} catch {
		return null;
	}
	if (!manifest || typeof manifest.pages !== "number") return null;
	// Newer than this build: refuse, never rewrite what it doesn't understand.
	if (typeof manifest.version === "number" && manifest.version > BOOK_FORMAT_VERSION) return null;
	return manifest;
}

const pageCache = new Map<string, { mtimeMs: number; pages: BookPage[] }>();

function readPages(folderId: string, bookId: string): BookPage[] {
	const file = path.join(bookDir(folderId, bookId), "pages.json");
	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch {
		return [];
	}
	const cached = pageCache.get(file);
	if (cached && cached.mtimeMs === mtimeMs) return cached.pages;
	const pages = readJson<BookPage[]>(file) ?? [];
	pageCache.set(file, { mtimeMs, pages });
	return pages;
}

function list(folderId: string): BookManifest[] {
	const dir = path.join(roadmapDir(folderId), "books");
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.map((id) => readManifest(folderId, id))
		.filter((m): m is BookManifest => m !== null)
		.sort((a, b) => a.sourceName.localeCompare(b.sourceName));
}

function write(folderId: string, book: { manifest: BookManifest; outline: BookOutlineNode[]; pages: BookPage[]; sourcePdf: string }): void {
	const dir = bookDir(folderId, book.manifest.id);
	fs.mkdirSync(dir, { recursive: true });
	fs.copyFileSync(book.sourcePdf, path.join(dir, "source.pdf"));
	fs.writeFileSync(path.join(dir, "outline.json"), JSON.stringify(book.outline), "utf-8");
	fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify(book.pages), "utf-8");
	// The manifest goes LAST: a book only exists once its manifest does, so an
	// interrupted ingest leaves nothing that reads as a finished book.
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(book.manifest, null, "\t"), "utf-8");
}

function patchManifest(folderId: string, bookId: string, patch: Partial<Pick<BookManifest, "key">>): BookManifest | null {
	const manifest = readManifest(folderId, bookId);
	if (!manifest) return null;
	const next = { ...manifest, ...patch };
	fs.writeFileSync(path.join(bookDir(folderId, bookId), "manifest.json"), JSON.stringify(next, null, "\t"), "utf-8");
	return next;
}

export const bookStore: BookStore = {
	list,
	readManifest,
	readOutline: (folderId, bookId) => readJson<BookOutlineNode[]>(path.join(bookDir(folderId, bookId), "outline.json")) ?? [],
	readPages,
	write,
	patchManifest,
	sourcePath: (folderId, bookId) => path.join(bookDir(folderId, bookId), "source.pdf"),
};
