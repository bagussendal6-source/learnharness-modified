/**
 * Roadmap store — the fs adapter for a roadmap folder's own data
 * (data/roadmaps/<folderId>/). Implements core/ports.ts RoadmapStore.
 *
 * Today the directory holds meta.json only; roadmap.json, progress.json,
 * books/ and index/ join it as later build steps land. The folder FLAG is the
 * library's business (store/library.ts) — this store never decides whether a
 * folder IS a roadmap, it only owns what a roadmap keeps.
 *
 * Same idioms as the notes/chat stores: sync fs, tab-indented JSON, an id
 * guard on every path, and a record stamped NEWER than this build is refused
 * on read (a read-modify-write store must never rewrite what it doesn't
 * understand).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { ROADMAP_FORMAT_VERSION, type ProgressDoc, type RoadmapDoc, type RoadmapMeta, type RoadmapSetupState, type TopicProgress } from "../core/contracts/roadmap.ts";
import type { RoadmapStore } from "../core/ports.ts";

/** The roadmap folder's data directory (id-guarded). Shared with the book store. */
export function roadmapDir(folderId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(folderId)) throw new Error(`Invalid roadmap folder id: ${folderId}`);
	return path.join(PATHS.roadmaps, folderId);
}

const metaFile = (folderId: string) => path.join(roadmapDir(folderId), "meta.json");

function readMeta(folderId: string): RoadmapMeta | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(metaFile(folderId), "utf-8"));
	} catch {
		return null;
	}
	const meta = parsed as Partial<RoadmapMeta> | null;
	if (!meta || typeof meta !== "object" || typeof meta.createdAt !== "string") return null;
	if (typeof meta.version === "number" && meta.version > ROADMAP_FORMAT_VERSION) {
		console.error(`[roadmap ${folderId}] stamped with format version ${meta.version} > ${ROADMAP_FORMAT_VERSION} — refusing to read`);
		return null;
	}
	return {
		version: ROADMAP_FORMAT_VERSION,
		folderId,
		createdAt: meta.createdAt,
		state: meta.state === "active" ? "active" : "setup",
	};
}

function writeMeta(meta: RoadmapMeta): void {
	fs.mkdirSync(roadmapDir(meta.folderId), { recursive: true });
	fs.writeFileSync(metaFile(meta.folderId), JSON.stringify(meta, null, "\t"), "utf-8");
}

function ensureRoadmap(folderId: string): RoadmapMeta {
	const existing = readMeta(folderId);
	if (existing) return existing;
	const meta: RoadmapMeta = { version: ROADMAP_FORMAT_VERSION, folderId, createdAt: new Date().toISOString(), state: "setup" };
	writeMeta(meta);
	return meta;
}

function setState(folderId: string, state: RoadmapSetupState): RoadmapMeta | null {
	const meta = readMeta(folderId);
	if (!meta) return null;
	const next = { ...meta, state };
	writeMeta(next);
	return next;
}

const roadmapFile = (folderId: string) => path.join(roadmapDir(folderId), "roadmap.json");

function readRoadmap(folderId: string): RoadmapDoc | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(roadmapFile(folderId), "utf-8"));
	} catch {
		return null;
	}
	const doc = parsed as Partial<RoadmapDoc> | null;
	if (!doc || typeof doc !== "object" || !Array.isArray(doc.topics)) return null;
	if (typeof doc.version === "number" && doc.version > ROADMAP_FORMAT_VERSION) return null;
	return doc as RoadmapDoc;
}

function writeRoadmap(folderId: string, roadmap: RoadmapDoc): void {
	fs.mkdirSync(roadmapDir(folderId), { recursive: true });
	fs.writeFileSync(roadmapFile(folderId), JSON.stringify(roadmap, null, "\t"), "utf-8");
}

const progressFile = (folderId: string) => path.join(roadmapDir(folderId), "progress.json");

function readProgress(folderId: string): ProgressDoc {
	const empty: ProgressDoc = { version: ROADMAP_FORMAT_VERSION, topics: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(progressFile(folderId), "utf-8"));
	} catch {
		return empty;
	}
	const doc = parsed as Partial<ProgressDoc> | null;
	if (!doc || typeof doc !== "object" || !doc.topics || typeof doc.topics !== "object") return empty;
	// Newer than this build: read as empty and never rewrite it (see updateTopic).
	if (typeof doc.version === "number" && doc.version > ROADMAP_FORMAT_VERSION) return empty;
	return { version: ROADMAP_FORMAT_VERSION, topics: doc.topics };
}

function updateTopic(folderId: string, topicId: string, patch: Partial<Omit<TopicProgress, "updatedAt">>): TopicProgress {
	if (typeof topicId !== "string" || topicId.trim() === "") throw new Error("Topic id is required.");
	// A progress file from a newer build must not be overwritten by this one.
	try {
		const raw = JSON.parse(fs.readFileSync(progressFile(folderId), "utf-8")) as { version?: unknown };
		if (typeof raw.version === "number" && raw.version > ROADMAP_FORMAT_VERSION) throw new Error(`progress.json is from a newer version (${raw.version}); refusing to overwrite it.`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("progress.json")) throw error;
	}
	const doc = readProgress(folderId);
	const next: TopicProgress = { status: "not_started", ...doc.topics[topicId], ...patch, updatedAt: new Date().toISOString() };
	doc.topics[topicId] = next;
	fs.mkdirSync(roadmapDir(folderId), { recursive: true });
	fs.writeFileSync(progressFile(folderId), JSON.stringify(doc, null, "\t"), "utf-8");
	return next;
}

export const roadmapStore: RoadmapStore = { readMeta, ensureRoadmap, setState, readRoadmap, writeRoadmap, readProgress, updateTopic };
