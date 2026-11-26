import { normalizeFolderName, sameFolder } from "../core/organize.ts";
import type { RoadmapFolderStatus } from "../core/contracts/roadmap.ts";
import { stores } from "./stores.ts";

/**
 * ROADMAP FOLDERS, server side: turning a folder into a roadmap folder and
 * back. Two stores meet here — the library holds the folder FLAG, the roadmap
 * store holds what the roadmap owns (keyed by a stable folder id, because
 * folder names are renameable).
 *
 * Sessions already in the folder are never touched, in either direction: a
 * record carries only its folder NAME, so converting changes nothing about
 * them. Turning a roadmap folder back to regular KEEPS its data on disk (a
 * later "Make this a roadmap folder" restores it); deleting that data is a
 * separate, explicit action that does not exist yet.
 *
 * Results are HTTP-shaped like server/library.ts, so the routes stay thin.
 */

export type RoadmapResult<T extends object = object> =
	| ({ ok: true } & T)
	| { ok: false; status: 400 | 404; code: string; error: string };

const fail = (status: 400 | 404, code: string, error: string): RoadmapResult<never> => ({ ok: false, status, code, error });

/** The library's own spelling of the folder, or null when it doesn't exist. */
function knownFolder(name: string): string | null {
	return stores.libraryStore.view().folders.find((f) => sameFolder(f, name)) ?? null;
}

function statusOf(folder: string): RoadmapFolderStatus {
	const meta = stores.libraryStore.getFolderMeta(folder);
	if (meta?.type === "roadmap") {
		return { folder, type: "roadmap", state: stores.roadmapStore.readMeta(meta.id)?.state ?? "setup", hasSavedRoadmap: false };
	}
	return { folder, type: "regular", state: null, hasSavedRoadmap: meta !== null && stores.roadmapStore.readMeta(meta.id) !== null };
}

export function roadmapStatus(rawName: unknown): RoadmapResult<{ roadmap: RoadmapFolderStatus }> {
	const name = normalizeFolderName(rawName);
	if (!name) return fail(400, "bad_name", "Folder name is required.");
	const folder = knownFolder(name);
	if (!folder) return fail(404, "not_found", "No such folder.");
	return { ok: true, roadmap: statusOf(folder) };
}

/** "Make this a roadmap folder". Idempotent; restores a saved roadmap when
 *  the folder had one. */
export function makeRoadmapFolder(rawName: unknown): RoadmapResult<{ roadmap: RoadmapFolderStatus }> {
	const name = normalizeFolderName(rawName);
	if (!name) return fail(400, "bad_name", "Folder name is required.");
	const folder = knownFolder(name);
	if (!folder) return fail(404, "not_found", "No such folder.");
	const id = stores.libraryStore.getFolderMeta(folder)?.id ?? `rm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	stores.roadmapStore.ensureRoadmap(id);
	stores.libraryStore.setFolderMeta(folder, { id, type: "roadmap" });
	return { ok: true, roadmap: statusOf(folder) };
}

/** Back to a regular folder. Nothing is deleted: the roadmap's data and every
 *  session stay exactly where they are. Idempotent. */
export function detachRoadmapFolder(rawName: unknown): RoadmapResult<{ roadmap: RoadmapFolderStatus }> {
	const name = normalizeFolderName(rawName);
	if (!name) return fail(400, "bad_name", "Folder name is required.");
	const folder = knownFolder(name);
	if (!folder) return fail(404, "not_found", "No such folder.");
	const meta = stores.libraryStore.getFolderMeta(folder);
	if (meta?.type === "roadmap") stores.libraryStore.setFolderMeta(folder, { id: meta.id, type: "regular" });
	return { ok: true, roadmap: statusOf(folder) };
}
