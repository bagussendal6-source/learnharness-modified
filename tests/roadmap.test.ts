/**
 * Roadmap folders: the pure sequencing rules (dependency order, next topic,
 * validation) and the folder flag (convert, detach, restore, rename, dissolve
 * guard) — with regular folders and existing sessions proven untouched. Runs
 * under an isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-roadmap-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { nextTopic, prerequisitesMet, roadmapCounts, roadmapProblems, topologicalOrder } = await import("../src/core/roadmap.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { libraryStore } = await import("../src/store/library.ts");
const { roadmapStore } = await import("../src/store/roadmap.ts");
const { createFolder, deleteFolder, renameFolder } = await import("../src/server/library.ts");
const { detachRoadmapFolder, makeRoadmapFolder, roadmapStatus } = await import("../src/server/roadmap.ts");

test.after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const topic = (id: string, prereqs: string[] = []) => ({ id, title: id.toUpperCase(), prereqs });
const progress = (entries: Record<string, "learning" | "shaky" | "mastered">) => ({
	version: 1,
	topics: Object.fromEntries(Object.entries(entries).map(([id, status]) => [id, { status, updatedAt: "2026-01-01T00:00:00.000Z" }])),
});

// ─── sequencing ──────────────────────────────────────────────────────────────

test("roadmapProblems: valid roadmaps are clean; every defect is named", () => {
	assert.deepEqual(roadmapProblems([topic("a"), topic("b", ["a"])]), []);
	assert.match(roadmapProblems([topic("a"), topic("a")]).join(" "), /share the id "a"/);
	assert.match(roadmapProblems([topic("a", ["ghost"])]).join(" "), /"ghost", which is not in the roadmap/);
	assert.match(roadmapProblems([topic("a", ["a"])]).join(" "), /lists itself/);
	assert.match(roadmapProblems([topic("a", ["b"]), topic("b", ["a"]), topic("c")]).join(" "), /loop through: a, b/);
	assert.match(roadmapProblems([{ id: "x", title: " ", prereqs: [] }]).join(" "), /no title/);
});

test("topologicalOrder: prerequisites first, roadmap order breaks ties", () => {
	// c needs a; b is independent. Roadmap order is c, b, a.
	const order = topologicalOrder([topic("c", ["a"]), topic("b"), topic("a")]).map((t) => t.id);
	assert.deepEqual(order, ["b", "a", "c"]);
});

test("nextTopic: first non-mastered topic whose prerequisites are all mastered", () => {
	const roadmap = { version: 1, topics: [topic("limits"), topic("derivatives", ["limits"]), topic("integrals", ["derivatives"]), topic("series", ["limits"])] };
	assert.equal(nextTopic(roadmap, null)?.id, "limits");
	assert.equal(nextTopic(roadmap, progress({ limits: "learning" }))?.id, "limits");
	// mastering limits opens BOTH dependents; the earlier one in the roadmap wins
	assert.equal(nextTopic(roadmap, progress({ limits: "mastered" }))?.id, "derivatives");
	// shaky does not open dependents: derivatives stays next, integrals stays closed
	assert.equal(nextTopic(roadmap, progress({ limits: "mastered", derivatives: "shaky" }))?.id, "derivatives");
	assert.equal(nextTopic(roadmap, progress({ limits: "mastered", derivatives: "mastered" }))?.id, "integrals");
	assert.equal(nextTopic(roadmap, progress({ limits: "mastered", derivatives: "mastered", integrals: "mastered", series: "mastered" })), null);
	assert.equal(nextTopic({ version: 1, topics: [] }, null), null);
});

test("prerequisitesMet + roadmapCounts", () => {
	const roadmap = { version: 1, topics: [topic("a"), topic("b", ["a"]), topic("c", ["a"]), topic("d")] };
	const done = progress({ a: "mastered", b: "shaky", c: "learning" });
	assert.equal(prerequisitesMet(roadmap.topics[1]!, done), true);
	assert.equal(prerequisitesMet(roadmap.topics[1]!, progress({ a: "shaky" })), false);
	assert.deepEqual(roadmapCounts(roadmap, done), { total: 4, mastered: 1, learning: 1, shaky: 1, notStarted: 1 });
});

// ─── the folder flag ─────────────────────────────────────────────────────────

test("a folder is regular by default and reports no roadmap", () => {
	createFolder("Kalkulus");
	const result = roadmapStatus("Kalkulus");
	assert.ok(result.ok);
	assert.deepEqual(result.roadmap, { folder: "Kalkulus", type: "regular", state: null, hasSavedRoadmap: false });
	assert.deepEqual(libraryStore.view().folderTypes, {});
	assert.equal(roadmapStatus("Ghost").ok, false);
});

test("convert: flags the folder, creates data under a stable id, leaves sessions alone", () => {
	const existing = chatStore.createChat("Limits", undefined, "Kalkulus");
	const before = JSON.stringify(chatStore.getChat(existing.id));
	const result = makeRoadmapFolder("kalkulus"); // case-insensitive, like every folder lookup
	assert.ok(result.ok);
	assert.deepEqual(result.roadmap, { folder: "Kalkulus", type: "roadmap", state: "setup", hasSavedRoadmap: false });
	assert.deepEqual(libraryStore.view().folderTypes, { Kalkulus: "roadmap" });
	const meta = libraryStore.getFolderMeta("Kalkulus")!;
	assert.match(meta.id, /^rm_[0-9a-f]{12}$/);
	assert.equal(roadmapStore.readMeta(meta.id)?.state, "setup");
	assert.ok(fs.existsSync(path.join(TMP_DATA, "roadmaps", meta.id, "meta.json")));
	// the session is byte-identical and still in the folder
	assert.equal(JSON.stringify(chatStore.getChat(existing.id)), before);
	assert.equal(chatStore.getChat(existing.id)?.folder, "Kalkulus");
	// idempotent: a second press changes nothing
	assert.equal(libraryStore.getFolderMeta("Kalkulus")!.id, meta.id);
	assert.ok(makeRoadmapFolder("Kalkulus").ok);
	assert.equal(libraryStore.getFolderMeta("Kalkulus")!.id, meta.id);
});

test("other folders stay regular", () => {
	createFolder("Fisika");
	assert.deepEqual(libraryStore.view().folderTypes, { Kalkulus: "roadmap" });
	const fisika = roadmapStatus("Fisika");
	assert.ok(fisika.ok && fisika.roadmap.type === "regular");
});

test("a roadmap folder cannot be dissolved; the refusal names the way out", () => {
	const result = deleteFolder("Kalkulus");
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.status, 409);
		assert.equal(result.code, "roadmap_folder");
	}
	assert.ok(libraryStore.view().folders.includes("Kalkulus"));
});

test("rename keeps the roadmap: the id follows the folder, the flag follows the new name", () => {
	const idBefore = libraryStore.getFolderMeta("Kalkulus")!.id;
	assert.ok(renameFolder("Kalkulus", "Kalkulus II").ok);
	assert.equal(libraryStore.getFolderMeta("Kalkulus II")?.id, idBefore);
	assert.equal(libraryStore.getFolderMeta("Kalkulus"), null);
	assert.deepEqual(libraryStore.view().folderTypes, { "Kalkulus II": "roadmap" });
	assert.ok(renameFolder("Kalkulus II", "Kalkulus").ok);
	assert.equal(libraryStore.getFolderMeta("Kalkulus")?.id, idBefore);
});

test("detach: back to regular, data and sessions kept; convert again restores the same roadmap", () => {
	const id = libraryStore.getFolderMeta("Kalkulus")!.id;
	const detached = detachRoadmapFolder("Kalkulus");
	assert.ok(detached.ok);
	assert.deepEqual(detached.roadmap, { folder: "Kalkulus", type: "regular", state: null, hasSavedRoadmap: true });
	assert.deepEqual(libraryStore.view().folderTypes, {});
	assert.ok(fs.existsSync(path.join(TMP_DATA, "roadmaps", id, "meta.json")));
	// a regular folder again: it may now be dissolved or renamed freely
	assert.ok(detachRoadmapFolder("Kalkulus").ok); // idempotent
	const restored = makeRoadmapFolder("Kalkulus");
	assert.ok(restored.ok);
	assert.equal(libraryStore.getFolderMeta("Kalkulus")!.id, id);
	assert.equal(restored.roadmap.hasSavedRoadmap, false);
});

test("a detached folder can be dissolved, and its saved roadmap comes back if the name returns", () => {
	const id = libraryStore.getFolderMeta("Kalkulus")!.id;
	assert.ok(detachRoadmapFolder("Kalkulus").ok);
	assert.ok(deleteFolder("Kalkulus").ok);
	assert.ok(!libraryStore.view().folders.includes("Kalkulus"));
	assert.ok(fs.existsSync(path.join(TMP_DATA, "roadmaps", id, "meta.json")), "data is never deleted by dissolving");
	createFolder("Kalkulus");
	const back = roadmapStatus("Kalkulus");
	assert.ok(back.ok && back.roadmap.type === "regular" && back.roadmap.hasSavedRoadmap);
});

test("roadmap store: refuses unsafe ids and newer-format files", () => {
	// reading an unsafe id is "no data" (never a path escape); writing one throws
	assert.equal(roadmapStore.readMeta("../escape"), null);
	assert.throws(() => roadmapStore.ensureRoadmap("../escape"), /Invalid roadmap folder id/);
	const dir = path.join(TMP_DATA, "roadmaps", "rm_future");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ version: 99, folderId: "rm_future", createdAt: "x", state: "active" }));
	assert.equal(roadmapStore.readMeta("rm_future"), null);
});
