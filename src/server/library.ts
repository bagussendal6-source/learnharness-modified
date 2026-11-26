import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { normalizeFolderName, sameFolder, type LibraryView } from "../core/organize.ts";
import { stores } from "./stores.ts";

/**
 * Library orchestration: folders span two stores (the library's file index
 * and the chat records), so renames and dissolves rewrite both. Results are
 * HTTP-shaped ({ok:false,status,...}) so the routes stay one-liners.
 */

export type LibraryResult<T extends object = object> =
	| ({ ok: true } & T)
	| { ok: false; status: 400 | 404 | 409; code: string; error: string; sessions?: { id: string; title: string }[] };

const fail = (status: 400 | 404 | 409, code: string, error: string): LibraryResult<never> => ({ ok: false, status, code, error });

/** Make a folder exist (idempotent) — new sessions filed into a fresh name. */
export function ensureFolder(name: string): string {
	return stores.libraryStore.ensureFolder(name);
}

export function libraryView(): LibraryView {
	return stores.libraryStore.view();
}

export function createFolder(raw: unknown): LibraryResult<{ folder: string }> {
	const name = normalizeFolderName(raw);
	if (!name) return fail(400, "bad_name", "Folder name can't be empty.");
	if (!stores.libraryStore.createFolder(name)) return fail(409, "exists", `A folder named "${name}" already exists.`);
	return { ok: true, folder: name };
}

export function renameFolder(rawFrom: unknown, rawTo: unknown): LibraryResult<{ folder: string }> {
	const from = normalizeFolderName(rawFrom);
	const to = normalizeFolderName(rawTo);
	if (!from || !to) return fail(400, "bad_name", "Both folder names are required.");
	if (!stores.libraryStore.renameFolder(from, to)) {
		const known = stores.libraryStore.view().folders.some((f) => sameFolder(f, from));
		return known ? fail(409, "exists", `A folder named "${to}" already exists.`) : fail(404, "not_found", "No such folder.");
	}
	stores.chatStore.retargetFolder(from, to);
	return { ok: true, folder: to };
}

/** Dissolve: sessions and files become unfiled — nothing is deleted. */
export function deleteFolder(rawName: unknown): LibraryResult {
	const name = normalizeFolderName(rawName);
	if (!name) return fail(400, "bad_name", "Folder name is required.");
	// A roadmap folder owns its books and index: dissolving it must be a
	// deliberate step (detach first), never a side effect of "remove folder".
	if (stores.libraryStore.getFolderMeta(name)?.type === "roadmap") {
		return fail(409, "roadmap_folder", `"${name}" is a roadmap folder. Turn it back into a regular folder first, then remove it.`);
	}
	if (!stores.libraryStore.deleteFolder(name)) return fail(404, "not_found", "No such folder.");
	stores.chatStore.retargetFolder(name, null);
	return { ok: true };
}

/** File a session into a folder (created on demand); null unfiles. */
export function fileSession(id: string, rawFolder: unknown) {
	const folder = normalizeFolderName(rawFolder);
	if (folder) stores.libraryStore.ensureFolder(folder);
	return stores.chatStore.setOrganization(id, { folder });
}

export function updateFile(id: string, patch: { name?: unknown; folder?: unknown }): LibraryResult<{ file: NonNullable<ReturnType<typeof stores.libraryStore.getFile>> }> {
	const file = stores.libraryStore.updateFile(id, {
		...(typeof patch.name === "string" ? { name: patch.name } : {}),
		...(patch.folder !== undefined ? { folder: patch.folder === null ? null : normalizeFolderName(patch.folder) } : {}),
	});
	return file ? { ok: true, file } : fail(404, "not_found", "No such file.");
}

/** Sessions whose transcript quotes this file's path ("Source file: <path>"). */
export function sessionsUsingFile(filePath: string): { id: string; title: string }[] {
	const needle = JSON.stringify(filePath).slice(1, -1);
	const found: { id: string; title: string }[] = [];
	let entries: string[] = [];
	try { entries = fs.readdirSync(PATHS.chats); } catch { return found; }
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		try {
			const raw = fs.readFileSync(path.join(PATHS.chats, entry), "utf-8");
			if (!raw.includes(needle)) continue;
			const parsed = JSON.parse(raw) as { id?: string; title?: string };
			if (parsed.id) found.push({ id: parsed.id, title: parsed.title ?? "Untitled session" });
		} catch { /* unreadable record — skip */ }
	}
	return found;
}

/** Deleting a stored file ALWAYS asks first: without `confirm` it answers
 *  409 confirm_required (listing the sessions that read it); with it, the
 *  bytes go. Old sessions that quoted the path can no longer re-read it. */
export function deleteFile(id: string, confirm: boolean): LibraryResult {
	const file = stores.libraryStore.getFile(id);
	if (!file) return fail(404, "not_found", "No such file.");
	if (!confirm) {
		const sessions = sessionsUsingFile(file.path);
		return {
			...fail(409, "confirm_required", sessions.length > 0
				? `"${file.name}" was attached in ${sessions.length} session${sessions.length === 1 ? "" : "s"}; they won't be able to read it again.`
				: `Delete "${file.name}"? This can't be undone.`),
			sessions,
		};
	}
	stores.libraryStore.removeFile(id);
	return { ok: true };
}
