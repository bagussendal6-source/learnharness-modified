/**
 * Session organization (folders + tags) and the file library's shapes.
 * Pure and browser-safe: the store, the routes and the sidebar all share
 * these normalizers, so "Integral" and "integral " can never become two tags.
 *
 * A FOLDER is where a session (or an uploaded file) lives — one per item,
 * free-form (a course, a project, anything). A TAG is a topic label — many
 * per session, free-form, and the AI may suggest them.
 */

import type { FolderType } from "./contracts/roadmap.ts";

export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 32;
export const MAX_FOLDER_LENGTH = 60;

/** lowercase, single-dash word joins, no leading "#". "" = not a tag. */
export function normalizeTag(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw
		.trim()
		.replace(/^#+/, "")
		.toLowerCase()
		.replace(/\s+/g, "-")
		.slice(0, MAX_TAG_LENGTH)
		.replace(/^-+|-+$/g, "");
}

/** Normalize, drop empties, dedupe (first wins), cap. Non-arrays read as []. */
export function normalizeTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const entry of raw) {
		const tag = normalizeTag(entry);
		if (tag && !out.includes(tag)) out.push(tag);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

/** Trimmed, single-spaced, capped. null = no folder (empty / not a string). */
export function normalizeFolderName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_FOLDER_LENGTH).trim();
	return name === "" ? null : name;
}

/** Folder identity is case-insensitive ("kalkulus" and "Kalkulus" are one). */
export function sameFolder(a: string | undefined | null, b: string | undefined | null): boolean {
	return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

/** One stored upload in the file library. `path` is what the agent reads:
 *  for a converted deck/document it is the PDF twin, while `name` stays the
 *  original ("deck.pptx"). */
export interface LibraryFile {
	id: string;
	name: string;
	path: string;
	folder?: string;
	size: number;
	addedAt: string;
}

export interface LibraryView {
	folders: string[];
	files: LibraryFile[];
	/** Folders that are not regular, by display name. Absent / missing key =
	 *  a regular (course) folder — pre-roadmap libraries need no migration. */
	folderTypes?: Record<string, FolderType>;
}

/** Uploaded copies are stored as "<8 hex>-<original name>"; a converted
 *  deck/document as "<8 hex>-<name>.pptx.pdf". Show what the learner picked. */
export function storedFileName(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.replace(/^[0-9a-f]{8}-/, "").replace(/(\.(?:pptx?|docx?))\.pdf$/i, "$1");
}

/** Display grouping for the sidebar: folders in library order first (each
 *  with its items, empty ones kept), then unfiled items. Pure. */
export function groupByFolder<T extends { folder?: string }>(
	items: readonly T[],
	folders: readonly string[],
): { folder: string | null; items: T[] }[] {
	const known = new Map(folders.map((f) => [f.toLowerCase(), f]));
	const buckets = new Map<string, T[]>(folders.map((f) => [f.toLowerCase(), []]));
	const loose: T[] = [];
	for (const item of items) {
		const key = (item.folder ?? "").toLowerCase();
		const bucket = key ? buckets.get(key) : undefined;
		if (bucket) bucket.push(item);
		else loose.push(item);
	}
	const groups = [...known.entries()].map(([key, name]) => ({ folder: name as string | null, items: buckets.get(key)! }));
	if (loose.length > 0) groups.push({ folder: null, items: loose });
	return groups;
}

// ─── the sidebar's list shaping (drag to folder, nested exams, the filter) ──

/** The dataTransfer type a dragged session row carries (its id). A drag that
 *  lacks it — an OS file, a text selection — is not a session move. */
export const SESSION_DRAG_TYPE = "application/x-lh-session";

/** The sidebar's kind filter (client-side over the one snapshot). */
export type SessionKindFilter = "teach" | "all" | "practice" | "exam";

/** A final-exam session is practice-kind + marked (core/exam.ts): it is its own
 *  kind of row — never inside Practice. */
export function matchesKindFilter(chat: { kind?: string; exam?: unknown }, filter: SessionKindFilter): boolean {
	const kind = chat.kind ?? "teach";
	switch (filter) {
		case "all":
			return true;
		case "exam":
			return chat.exam !== undefined;
		case "practice":
			return kind === "practice" && chat.exam === undefined;
		case "teach":
			return kind === "teach";
	}
}

/** Final exams live UNDER the session they examine instead of as rows of
 *  their own. Exams whose parent is not in `items` (deleted, filtered out,
 *  not matching a search) stay top-level so they never vanish. Pure; order
 *  is preserved on both sides. */
export function nestExams<T extends { id: string; exam?: { parentChatId: string } }>(
	items: readonly T[],
): { top: T[]; examsByParent: Map<string, T[]> } {
	const ids = new Set(items.map((i) => i.id));
	const examsByParent = new Map<string, T[]>();
	const top: T[] = [];
	for (const item of items) {
		const parent = item.exam?.parentChatId;
		if (parent !== undefined && ids.has(parent)) {
			const list = examsByParent.get(parent) ?? [];
			list.push(item);
			examsByParent.set(parent, list);
		} else top.push(item);
	}
	return { top, examsByParent };
}

/** The list with one session moved to `folder` (null = unfiled) — the
 *  optimistic twin of the server's file/unfile. Other items are untouched
 *  (same references); an unknown id changes nothing. The folder name is
 *  normalized exactly as the server will. */
export function withFolder<T extends { id: string; folder?: string }>(items: readonly T[], id: string, folder: string | null): T[] {
	const name = normalizeFolderName(folder);
	return items.map((item) => {
		if (item.id !== id) return item;
		const next = { ...item };
		if (name) next.folder = name;
		else delete next.folder;
		return next;
	});
}

/** Would dropping `id` into `folder` change anything? (Dropping a session back
 *  where it already is must not fire a request.) Folder names compare the way
 *  the app compares them: case-insensitively, null = unfiled. */
export function dropChangesFolder(item: { folder?: string } | undefined, folder: string | null): boolean {
	if (!item) return false;
	return !sameFolder(item.folder ?? null, folder ?? null);
}
