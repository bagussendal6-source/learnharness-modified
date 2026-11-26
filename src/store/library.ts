/**
 * Library store — the folder list + the index of uploaded source files
 * (data/library.json). The files themselves stay flat in data/sources/
 * (where /api/sources has always put them); folders are METADATA, so moving
 * a file between folders never touches the disk and every path a past
 * session quoted stays valid.
 *
 * Sync fs, tab-indented JSON — the chat store's idioms. Files that predate
 * the index (or arrive some other way) are adopted on read; index entries
 * whose file vanished are pruned.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { FolderMeta, FolderType } from "../core/contracts/roadmap.ts";
import { normalizeFolderName, sameFolder, storedFileName, type LibraryFile, type LibraryView } from "../core/organize.ts";

const SOURCES_DIR = () => path.join(PATHS.data, "sources");
const LIBRARY_FILE = () => path.join(PATHS.data, "library.json");
/** What the upload route accepts; converted decks/documents are .pdf twins. */
const ADOPTABLE = new Set([".pdf", ".md", ".markdown", ".txt"]);
const CONVERTED_ORIGINAL = /\.(pptx?|docx?)$/i;

interface LibraryRecord {
	folders: string[];
	files: LibraryFile[];
	/** Per-folder flag (roadmap folders), keyed by the LOWERCASED folder name —
	 *  folder identity is case-insensitive. A folder with no entry is regular.
	 *  An entry survives a dissolve on purpose: re-creating the folder name
	 *  offers its saved roadmap back instead of orphaning it. */
	folderMeta: Record<string, FolderMeta>;
}

const metaKey = (name: string) => name.toLowerCase();

function parseFolderMeta(raw: unknown): Record<string, FolderMeta> {
	const out: Record<string, FolderMeta> = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const meta = value as Partial<FolderMeta> | null;
		if (!meta || typeof meta.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(meta.id)) continue;
		out[key] = { id: meta.id, type: meta.type === "roadmap" ? "roadmap" : "regular" };
	}
	return out;
}

function readRecord(): LibraryRecord {
	try {
		const parsed = JSON.parse(fs.readFileSync(LIBRARY_FILE(), "utf-8")) as Partial<LibraryRecord>;
		return {
			folders: Array.isArray(parsed.folders) ? parsed.folders.filter((f): f is string => typeof f === "string") : [],
			files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is LibraryFile => !!f && typeof f.id === "string" && typeof f.path === "string") : [],
			folderMeta: parseFolderMeta((parsed as { folderMeta?: unknown }).folderMeta),
		};
	} catch {
		return { folders: [], files: [], folderMeta: {} };
	}
}

function writeRecord(record: LibraryRecord): void {
	fs.mkdirSync(path.dirname(LIBRARY_FILE()), { recursive: true });
	fs.writeFileSync(LIBRARY_FILE(), JSON.stringify(record, null, "\t"), "utf-8");
}

function newId(): string {
	return `file_${crypto.randomUUID().slice(0, 12)}`;
}

/** Read the library, adopting stray files and pruning vanished ones. */
function load(): LibraryRecord {
	const record = readRecord();
	let dirty = false;
	const kept = record.files.filter((f) => {
		const alive = fs.existsSync(f.path);
		if (!alive) dirty = true;
		return alive;
	});
	record.files = kept;
	const known = new Set(kept.map((f) => f.path));
	let entries: string[] = [];
	try { entries = fs.readdirSync(SOURCES_DIR()); } catch { /* no uploads yet */ }
	for (const entry of entries) {
		const full = path.join(SOURCES_DIR(), entry);
		if (known.has(full)) continue;
		const ext = path.extname(entry).toLowerCase();
		// A converted original sits next to its PDF twin; the twin is the entry.
		if (CONVERTED_ORIGINAL.test(entry) && fs.existsSync(`${full}.pdf`)) continue;
		if (!ADOPTABLE.has(ext)) continue;
		let stat: fs.Stats;
		try { stat = fs.statSync(full); } catch { continue; }
		if (!stat.isFile()) continue;
		record.files.push({ id: newId(), name: storedFileName(full), path: full, size: stat.size, addedAt: stat.mtime.toISOString() });
		dirty = true;
	}
	if (dirty) writeRecord(record);
	return record;
}

function ensureFolder(record: LibraryRecord, name: string): string {
	const existing = record.folders.find((f) => sameFolder(f, name));
	if (existing) return existing;
	record.folders.push(name);
	return name;
}

export const libraryStore = {
	view(): LibraryView {
		const { folders, files, folderMeta } = load();
		const folderTypes: Record<string, FolderType> = {};
		for (const folder of folders) {
			if (folderMeta[metaKey(folder)]?.type === "roadmap") folderTypes[folder] = "roadmap";
		}
		return { folders, files: [...files].sort((a, b) => b.addedAt.localeCompare(a.addedAt)), folderTypes };
	},

	/** The folder's flag, or null for a plain regular folder that never was a roadmap. */
	getFolderMeta(name: string): FolderMeta | null {
		return load().folderMeta[metaKey(name)] ?? null;
	},

	/** Set (or clear, with null) a folder's flag. False when the folder doesn't exist. */
	setFolderMeta(name: string, meta: FolderMeta | null): boolean {
		const record = load();
		if (!record.folders.some((f) => sameFolder(f, name))) return false;
		if (meta) record.folderMeta[metaKey(name)] = meta;
		else delete record.folderMeta[metaKey(name)];
		writeRecord(record);
		return true;
	},

	/** Register fresh uploads (optionally into a folder, created on demand). */
	addFiles(entries: { name: string; path: string; size: number }[], folder?: string | null): LibraryFile[] {
		const record = load();
		const target = normalizeFolderName(folder);
		const resolved = target ? ensureFolder(record, target) : undefined;
		// load() may have just adopted these very files as strays — the explicit
		// registration (name, folder) wins, so drop the adopted twins first.
		const incoming = new Set(entries.map((e) => e.path));
		record.files = record.files.filter((f) => !incoming.has(f.path));
		const added = entries.map((e): LibraryFile => ({
			id: newId(),
			name: e.name,
			path: e.path,
			...(resolved ? { folder: resolved } : {}),
			size: e.size,
			addedAt: new Date().toISOString(),
		}));
		record.files.push(...added);
		writeRecord(record);
		return added;
	},

	getFile(id: string): LibraryFile | null {
		return load().files.find((f) => f.id === id) ?? null;
	},

	/** Patch a file's name and/or folder (folder null = unfile). */
	updateFile(id: string, patch: { name?: string; folder?: string | null }): LibraryFile | null {
		const record = load();
		const file = record.files.find((f) => f.id === id);
		if (!file) return null;
		if (typeof patch.name === "string" && patch.name.trim() !== "") file.name = patch.name.trim();
		if (patch.folder !== undefined) {
			const folder = normalizeFolderName(patch.folder);
			if (folder) file.folder = ensureFolder(record, folder);
			else delete file.folder;
		}
		writeRecord(record);
		return file;
	},

	/** Remove the index entry AND the bytes (a converted file's original too). */
	removeFile(id: string): boolean {
		const record = load();
		const file = record.files.find((f) => f.id === id);
		if (!file) return false;
		record.files = record.files.filter((f) => f.id !== id);
		writeRecord(record);
		const doomed = [file.path];
		if (/\.(pptx?|docx?)\.pdf$/i.test(file.path)) doomed.push(file.path.slice(0, -4));
		for (const p of doomed) fs.rmSync(p, { force: true });
		return true;
	},

	/** Folder CRUD. createFolder → false when it already exists. */
	createFolder(name: string): boolean {
		const record = load();
		if (record.folders.some((f) => sameFolder(f, name))) return false;
		record.folders.push(name);
		writeRecord(record);
		return true;
	},

	/** Make sure a folder exists (a session was filed into a fresh name). */
	ensureFolder(name: string): string {
		const record = load();
		const had = record.folders.some((f) => sameFolder(f, name));
		const resolved = ensureFolder(record, name);
		if (!had) writeRecord(record);
		return resolved;
	},

	/** Rename; false when `from` is unknown or `to` collides with another folder. */
	renameFolder(from: string, to: string): boolean {
		const record = load();
		const index = record.folders.findIndex((f) => sameFolder(f, from));
		if (index < 0) return false;
		if (!sameFolder(from, to) && record.folders.some((f) => sameFolder(f, to))) return false;
		// A saved (detached) roadmap left behind under the target name is a
		// collision too: moving onto it would orphan or overwrite that data.
		if (!sameFolder(from, to) && record.folderMeta[metaKey(to)]) return false;
		const meta = record.folderMeta[metaKey(from)];
		if (meta) {
			delete record.folderMeta[metaKey(from)];
			record.folderMeta[metaKey(to)] = meta;
		}
		record.folders[index] = to;
		for (const f of record.files) if (sameFolder(f.folder, from)) f.folder = to;
		writeRecord(record);
		return true;
	},

	/** Drop the folder; its files become unfiled (never deleted). */
	deleteFolder(name: string): boolean {
		const record = load();
		if (!record.folders.some((f) => sameFolder(f, name))) return false;
		record.folders = record.folders.filter((f) => !sameFolder(f, name));
		for (const f of record.files) if (sameFolder(f.folder, name)) delete f.folder;
		writeRecord(record);
		return true;
	},
};
