/**
 * NotesStore — the fs JSON adapter (one file per chat in data/notes/).
 *
 * Implements core/ports.ts NotesStore; the shapes and every rule about them
 * live in core/notes.ts. Same idioms as the chat store: sync fs, tiny
 * records, id-guarded filenames, tab-indented JSON, wired only in the
 * composition root (src/server/stores.ts).
 *
 * Append-only by construction: the only write paths are appendPage (which
 * refuses a page that is not exactly the next one) and setOwn (which touches
 * one page's own-words field). Earlier pages are never rewritten.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { emptyNotes, NOTES_FORMAT_VERSION, type NotePage, type NotesRecord } from "../core/notes.ts";
import type { NotesStore } from "../core/ports.ts";

function notesFile(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.notes, `${chatId}.json`);
}

function readNotes(chatId: string): NotesRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(notesFile(chatId), "utf-8"));
	} catch {
		return null;
	}
	const rec = parsed as Partial<NotesRecord> | null;
	if (!rec || typeof rec !== "object" || !Array.isArray(rec.pages)) return null;
	// A record stamped NEWER than this build reads as absent — never rewrite
	// what this build does not understand (the chat store's downgrade law).
	if (typeof rec.version === "number" && rec.version > NOTES_FORMAT_VERSION) {
		console.error(`[notes ${chatId}] stamped with format version ${rec.version} > ${NOTES_FORMAT_VERSION} — refusing to read`);
		return null;
	}
	return { version: NOTES_FORMAT_VERSION, chatId, pages: rec.pages as NotePage[] };
}

function write(record: NotesRecord): void {
	fs.mkdirSync(PATHS.notes, { recursive: true });
	fs.writeFileSync(notesFile(record.chatId), JSON.stringify(record, null, "\t"), "utf-8");
}

function appendPage(chatId: string, page: NotePage): NotesRecord {
	const record = readNotes(chatId) ?? emptyNotes(chatId);
	if (page.n !== record.pages.length + 1) {
		throw new Error(`Notes page ${page.n} is not the next page (expected ${record.pages.length + 1}).`);
	}
	record.pages.push(page);
	write(record);
	emit("notes-changed", { chatId });
	return record;
}

function setOwn(chatId: string, pageNumber: number, own: string): NotesRecord {
	const record = readNotes(chatId);
	const page = record?.pages.find((p) => p.n === pageNumber);
	if (!record || !page) throw new Error(`Notes page not found: ${chatId} #${pageNumber}`);
	page.own = own.trim();
	write(record);
	emit("notes-changed", { chatId });
	return record;
}

function deleteNotes(chatId: string): boolean {
	try {
		fs.unlinkSync(notesFile(chatId));
		return true;
	} catch {
		return false;
	}
}

export const notesStore: NotesStore = { readNotes, appendPage, setOwn, deleteNotes };
