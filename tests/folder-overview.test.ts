/**
 * The FOLDER OVERVIEW (src/core/folder-overview.ts, src/server/folders.ts):
 * one derived card per session — tags, the plan's own steps, progress, the
 * exam-aware completion line, and the latest notes line. No model, no storage;
 * everything folds from data the app already keeps. The server half runs under
 * an isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { buildSessionCard, CARD_MATERIAL_MAX, folderSummaryLine, latestNoteLine, sortCards, type SessionCard, type SessionCardInput } from "../src/core/folder-overview.ts";
import type { ExamAttempt, ExamResult } from "../src/core/exam.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newSessionClosedMessage } from "../src/core/native-messages.ts";
import { buildPage, buildSkippedPage, emptyDraft } from "../src/core/notes.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-folder-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { stores } = await import("../src/server/stores.ts");
const { folderOverview } = await import("../src/server/folders.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const as = (m: unknown) => m as LhMessage;
let seq = 0;
const quiz = (nodeId: string): LhMessage[] => {
	const id = `q${++seq}`;
	return [
		as({ role: "assistant", id: `a_${id}`, content: [{ type: "toolCall", id, name: "quiz", arguments: { nodeId } }] }),
		as({ role: "toolResult", id: `r_${id}`, toolCallId: id, toolName: "quiz", isError: false, details: { questionText: "Q", correct: true, confidence: 90 } }),
	];
};
const tree = (ids: string[]) => ({ nodes: ids.map((id) => ({ id, title: `Step ${id}` })), edges: [], version: 1 });
const result = (percent: number): ExamResult => ({ total: 8, concluded: 8, finished: true, points: (percent / 100) * 8, percent, grade: percent >= 90 ? "A" : percent >= 80 ? "B" : percent >= 70 ? "C" : percent >= 60 ? "D" : "E", passed: percent >= 80, perProposition: [] });
const attempt = (percent: number): ExamAttempt => ({ examChatId: `e${percent}`, at: "2026-11-06T00:00:00.000Z", result: result(percent) });
const input = (over: Partial<SessionCardInput> = {}): SessionCardInput => ({ id: "c1", title: "Chain rule", updatedAt: "2026-11-01T00:00:00.000Z", tree: tree(["a", "b"]), messages: [...quiz("a")], attempts: [], pages: [], ...over });
const page = (over: Record<string, unknown> = {}) => buildPage({ ...emptyDraft(), summary: "Did the chain rule.", concepts: [{ title: "Composite", body: "b", refs: [] }], ...over }, [], { createdAt: "2026-11-02T00:00:00.000Z", toMessageId: "m1", origin: "ai" });

describe("buildSessionCard", () => {
	it("carries identity, tags and recency straight through", () => {
		const c = buildSessionCard(input({ tags: ["turunan", "aturan-rantai"] }));
		assert.deepEqual([c.id, c.title, c.kind, c.updatedAt, c.tags], ["c1", "Chain rule", "teach", "2026-11-01T00:00:00.000Z", ["turunan", "aturan-rantai"]]);
	});

	it("material is the plan's own steps in plan order; progress is steps reached", () => {
		const c = buildSessionCard(input({ messages: [...quiz("a"), ...quiz("b")] }));
		assert.deepEqual(c.material, { titles: ["Step a", "Step b"], more: 0 });
		assert.deepEqual(c.progress, { covered: 2, total: 2 });
	});

	it("a long plan lists the first few steps and counts the rest", () => {
		const ids = Array.from({ length: CARD_MATERIAL_MAX + 3 }, (_, i) => `n${i}`);
		const c = buildSessionCard(input({ tree: tree(ids), messages: [] }));
		assert.equal(c.material.titles.length, CARD_MATERIAL_MAX);
		assert.equal(c.material.more, 3);
	});

	it("no plan: no material, no progress, still a card", () => {
		const c = buildSessionCard(input({ tree: null, messages: [] }));
		assert.deepEqual(c.material, { titles: [], more: 0 });
		assert.equal(c.progress, null);
	});

	it("completion follows the exam: in progress → all plan clear → not passed → completed", () => {
		const covered = [...quiz("a"), ...quiz("b")];
		assert.equal(buildSessionCard(input({ messages: [...quiz("a")] })).completion!.status, "not-covered");
		const ready = buildSessionCard(input({ messages: covered }));
		assert.equal(ready.completion!.status, "ready");
		assert.equal(ready.completion!.line, "All plan clear — take the final exam.");
		const notPassed = buildSessionCard(input({ messages: covered, attempts: [attempt(72)] }));
		assert.equal(notPassed.completion!.status, "not-passed");
		assert.equal(notPassed.completion!.line, "All plan clear · Exam not passed (best C, 72%) — need retest!");
		const done = buildSessionCard(input({ messages: covered, attempts: [attempt(72), attempt(88)] }));
		assert.equal(done.completion!.status, "completed");
		assert.deepEqual(done.completion!.best, { grade: "B", percent: 88, passed: true });
	});

	it("a practice session has no completion and no exam", () => {
		const c = buildSessionCard(input({ kind: "practice" }));
		assert.equal(c.kind, "practice");
		assert.equal(c.completion, null);
	});

	it("knows when the session is closed right now", () => {
		assert.equal(buildSessionCard(input()).closed, false);
		assert.equal(buildSessionCard(input({ messages: [...quiz("a"), newSessionClosedMessage({ pageNumber: 1, notes: true })] })).closed, true);
	});

	it("notes: counts written pages vs closed sessions, and quotes the newest written one", () => {
		const p1 = page();
		const skipped = buildSkippedPage([p1], { createdAt: "2026-11-03T00:00:00.000Z", toMessageId: "m5" });
		const c = buildSessionCard(input({ pages: [p1, skipped] }));
		assert.deepEqual(c.notes, { written: 1, sessions: 2, latest: "Did the chain rule." });
	});

	it("no notes at all", () => {
		assert.deepEqual(buildSessionCard(input()).notes, { written: 0, sessions: 0, latest: null });
	});
});

describe("latestNoteLine", () => {
	it("falls back to the first concept titles when a page has no summary", () => {
		const p = page({ summary: "", concepts: [{ title: "A", body: "x", refs: [] }, { title: "B", body: "x", refs: [] }] });
		assert.equal(latestNoteLine([p]), "A · B");
	});
	it("null when only skipped pages exist", () => {
		assert.equal(latestNoteLine([buildSkippedPage([], { createdAt: "2026-11-03T00:00:00.000Z", toMessageId: "m1" })]), null);
	});
});

describe("folderSummaryLine and sortCards", () => {
	const card = (id: string, updatedAt: string, tags: string[] = [], status?: "completed" | "ready"): SessionCard => ({
		...buildSessionCard(input({ id, updatedAt, tags })),
		completion: status ? { status, line: null, best: null } : null,
	});

	it("counts sessions, distinct tags and files — dropping the zeros", () => {
		assert.equal(folderSummaryLine([card("a", "x", ["t1", "t2"]), card("b", "y", ["t1"])], 1), "2 sessions · 2 tags · 1 file");
		assert.equal(folderSummaryLine([card("a", "x")], 0), "1 session");
	});

	it("in-progress work first (newest first), finished sessions last", () => {
		const sorted = sortCards([card("done", "2026-11-09", [], "completed"), card("old", "2026-11-01"), card("new", "2026-11-05")]);
		assert.deepEqual(sorted.map((c) => c.id), ["new", "old", "done"]);
	});
});

describe("folderOverview (server)", () => {
	function chatIn(folder: string, title: string, covered = true) {
		const chat = stores.chatStore.createChat(title, undefined, folder);
		stores.chatStore.saveTree(chat.id, tree(["a", "b"]));
		stores.chatStore.saveMessages(chat.id, [as({ role: "user", id: "u", content: "x" }), ...quiz("a"), ...(covered ? quiz("b") : [])]);
		return chat.id;
	}

	it("lists only this folder's sessions, case-insensitively", () => {
		const a = chatIn("Kalkulus II", "In the folder");
		chatIn("Fisika", "Elsewhere");
		const out = folderOverview("kalkulus ii");
		assert.deepEqual(out.cards.map((c) => c.id), [a]);
		assert.equal(out.folder, "Kalkulus II");
	});

	it("never lists a final-exam session as its own card (it rides its parent)", () => {
		const parent = chatIn("Course", "Parent");
		const exam = stores.chatStore.createChat("Final exam — Parent", "practice", "Course");
		stores.chatStore.setExam(exam.id, { parentChatId: parent, total: 8 });
		assert.deepEqual(folderOverview("Course").cards.map((c) => c.id), [parent]);
	});

	it("folds the exam attempts into the parent's completion", () => {
		const parent = chatIn("Graded", "Graded parent");
		const exam = stores.chatStore.createChat("Final exam — x", "practice");
		stores.chatStore.setExam(exam.id, { parentChatId: parent, total: 8 });
		const problems = Array.from({ length: 8 }, (_, i) => {
			const p = `p${i}`;
			const c = `c${i}`;
			return [
				as({ role: "assistant", id: `ap${i}`, content: [{ type: "toolCall", id: p, name: "problem", arguments: { statement: "s", mode: "recall", modelSolution: "m" } }] }),
				as({ role: "toolResult", id: `rp${i}`, toolCallId: p, toolName: "problem", isError: false }),
				as({ role: "assistant", id: `ac${i}`, content: [{ type: "toolCall", id: c, name: "conclude", arguments: { outcome: i < 7 ? "solved" : "surrendered", verdict: "v", rung: null, missClass: null, retest: false } }] }),
				as({ role: "toolResult", id: `rc${i}`, toolCallId: c, toolName: "conclude", isError: false }),
			];
		}).flat();
		stores.chatStore.saveMessages(exam.id, problems);
		const card = folderOverview("Graded").cards.find((c) => c.id === parent)!;
		assert.equal(card.completion!.status, "completed");
		assert.deepEqual(card.completion!.best, { grade: "B", percent: 88, passed: true });
	});

	it("an unknown folder is just empty", () => {
		assert.deepEqual(folderOverview("Nowhere").cards, []);
	});
});
