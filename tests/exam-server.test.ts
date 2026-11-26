/**
 * The final exam, server side (src/server/exam.ts): who may be examined, what
 * the exam session is made of, and how the chat's completion folds over its
 * exam attempts. Runs under an isolated LH_DATA_DIR (set before any
 * config-loading import). No LLM, no network: the examiner agent itself is not
 * run — exam transcripts are written directly, the way a finished exam lands.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import type { LhMessage } from "../src/core/native-messages.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-server-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { stores } = await import("../src/server/stores.ts");
const { startExam, examAttemptsOf, completionForChat, examStateOf } = await import("../src/server/exam.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

let seq = 0;
const as = (m: unknown) => m as LhMessage;
const quiz = (nodeId: string): LhMessage[] => {
	const id = `q${++seq}`;
	return [
		as({ role: "assistant", id: `a_${id}`, content: [{ type: "toolCall", id, name: "quiz", arguments: { nodeId } }] }),
		as({ role: "toolResult", id: `r_${id}`, toolCallId: id, toolName: "quiz", isError: false, details: {} }),
	];
};
const problem = (outcome: string, target: string[]): LhMessage[] => {
	const p = `p${++seq}`;
	const c = `c${seq}`;
	return [
		as({ role: "assistant", id: `ap_${p}`, content: [{ type: "toolCall", id: p, name: "problem", arguments: { statement: "s", mode: "recall", modelSolution: "m", target } }] }),
		as({ role: "toolResult", id: `rp_${p}`, toolCallId: p, toolName: "problem", isError: false }),
		as({ role: "assistant", id: `ac_${c}`, content: [{ type: "toolCall", id: c, name: "conclude", arguments: { outcome, verdict: "v", rung: null, missClass: null, retest: false } }] }),
		as({ role: "toolResult", id: `rc_${c}`, toolCallId: c, toolName: "conclude", isError: false }),
	];
};

/** A teaching session whose 2-node plan is fully covered. */
function coveredParent(title = "Calculus") {
	const chat = stores.chatStore.createChat(title);
	stores.chatStore.saveTree(chat.id, { nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }], edges: [], version: 1 });
	stores.chatStore.saveMessages(chat.id, [as({ role: "user", id: "u1", content: "teach me" }), ...quiz("a"), ...quiz("b")]);
	return chat.id;
}

function addNode(id: string, name: string, chatId: string) {
	stores.graphStore.appendNode({ id, name, statement: `${name} holds.`, aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId, messageId: "" }] });
}

describe("startExam: who may be examined", () => {
	it("an unknown session → 404", () => {
		const r = startExam("chat_missing");
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.status, 404);
	});

	it("a plan that is not fully covered → 409 not_covered", () => {
		const chat = stores.chatStore.createChat("Partial");
		stores.chatStore.saveTree(chat.id, { nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }], edges: [], version: 1 });
		stores.chatStore.saveMessages(chat.id, [...quiz("a")]);
		const r = startExam(chat.id);
		assert.equal(!r.ok && r.code, "not_covered");
	});

	it("covered but nothing from it in the graph yet → 409 no_material", () => {
		const r = startExam(coveredParent("No graph yet"));
		assert.equal(!r.ok && r.code, "no_material");
	});

	it("a practice session has no final exam", () => {
		const practice = stores.chatStore.createChat("Drill", "practice");
		const r = startExam(practice.id);
		assert.equal(!r.ok && r.code, "not_teaching");
	});
});

describe("startExam: the exam session", () => {
	it("creates a practice-kind session marked as the exam, with the material in its context", () => {
		const parentId = coveredParent("Chain rule course");
		addNode("n_exam_1", "Chain rule", parentId);
		addNode("n_exam_2", "Composites", parentId);
		addNode("n_other", "Unrelated", "some_other_chat");
		const r = startExam(parentId);
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.prompt, "Begin the final exam.");
		const exam = stores.chatStore.getChat(r.id)!;
		assert.equal(exam.kind, "practice");
		assert.deepEqual(exam.exam, { parentChatId: parentId, total: 8 });
		assert.equal(exam.titleSource, "manual", "the AI namer must never rename an exam");
		assert.ok(exam.title.startsWith("Final exam — Chain rule course"));
		const marker = exam.messages[0] as unknown as { customType: string; content: string; details: { propositions: { id: string }[] } };
		assert.equal(marker.customType, "graph-context");
		assert.ok(marker.content.includes("exactly 8 problems"));
		assert.deepEqual(marker.details.propositions.map((p) => p.id).sort(), ["n_exam_1", "n_exam_2"], "only this session's propositions");
	});

	it("the exam is its own sidebar entry: marked in the list, with a derived score line", () => {
		const parentId = coveredParent("Listed");
		addNode("n_listed", "Listed idea", parentId);
		const r = startExam(parentId);
		assert.equal(r.ok, true);
		if (!r.ok) return;
		const summary = stores.chatStore.listChats().find((c) => c.id === r.id)!;
		assert.equal(summary.exam?.parentChatId, parentId);
		assert.equal(summary.examResult?.concluded, 0);
		assert.equal(summary.examResult?.finished, false);
	});
});

describe("completion folds over the exam attempts", () => {
	/** An exam session for `parentId` with `n` of 8 problems solved. */
	function finishedExam(parentId: string, solved: number, target = ["n_c1"]): string {
		const exam = stores.chatStore.createChat("Final exam — x", "practice");
		stores.chatStore.setExam(exam.id, { parentChatId: parentId, total: 8 });
		const msgs = Array.from({ length: 8 }, (_, i) => problem(i < solved ? "solved" : "surrendered", target)).flat();
		stores.chatStore.saveMessages(exam.id, msgs);
		return exam.id;
	}

	it("covered, no exam → ready", () => {
		const r = completionForChat(coveredParent("Fresh"));
		assert.equal(r.ok && r.completion.status, "ready");
	});

	it("an unknown chat → 404", () => {
		assert.equal(completionForChat("chat_missing").ok, false);
	});

	it("exam below the mark → not-passed, and the line says need retest", async () => {
		const parentId = coveredParent("Below");
		finishedExam(parentId, 5); // 63% → D
		const r = completionForChat(parentId);
		assert.ok(r.ok);
		if (!r.ok) return;
		assert.equal(r.completion.status, "not-passed");
		const { completionLine } = await import("../src/core/exam.ts");
		assert.equal(completionLine(r.completion), "All plan clear · Exam not passed (best D, 63%) — need retest!");
	});

	it("a retest that reaches B completes it; a later bad attempt does not undo it", () => {
		const parentId = coveredParent("Retest");
		finishedExam(parentId, 4);
		assert.equal(completionForChat(parentId).ok && (completionForChat(parentId) as { completion: { status: string } }).completion.status, "not-passed");
		finishedExam(parentId, 7); // 88% → B
		const done = completionForChat(parentId);
		assert.ok(done.ok && done.completion.status === "completed");
		finishedExam(parentId, 1); // worse, later
		const still = completionForChat(parentId);
		assert.ok(still.ok && still.completion.status === "completed");
		assert.equal(examAttemptsOf(parentId).length, 3);
	});

	it("an exam still in progress is not a result", () => {
		const parentId = coveredParent("In progress");
		const exam = stores.chatStore.createChat("Final exam — y", "practice");
		stores.chatStore.setExam(exam.id, { parentChatId: parentId, total: 8 });
		stores.chatStore.saveMessages(exam.id, [...problem("solved", ["n_c1"]), ...problem("solved", ["n_c1"])]);
		const r = completionForChat(parentId);
		assert.ok(r.ok && r.completion.status === "ready");
	});

	it("examStateOf names the propositions in the breakdown and points back to the session", () => {
		const parentId = coveredParent("Named");
		addNode("n_named", "Named idea", parentId);
		const examId = finishedExam(parentId, 8, ["n_named"]);
		const s = examStateOf(examId);
		assert.ok(s.ok);
		if (!s.ok) return;
		assert.equal(s.state.result.passed, true);
		assert.equal(s.state.parentChatId, parentId);
		assert.equal(s.state.parentTitle, "Named");
		assert.equal(s.state.propositions.n_named, "Named idea");
		assert.equal(examStateOf(parentId).ok, false, "a teaching session is not an exam");
	});
});

describe("the examiner's prompt (its own — the others are untouched)", () => {
	it("is composed from prompts/exam and states the exam's rules", () => {
		const t = composeInstructions("exam");
		assert.ok(t.includes("FINAL EXAM"));
		assert.ok(t.includes("exactly the number of problems"));
		assert.ok(t.includes("no hints") || t.includes("There are no hints"));
		assert.ok(t.includes("Never use `solvedWithHints`"));
	});

	it("is a different prompt from practice, and practice keeps its own doctrine", () => {
		const exam = composeInstructions("exam");
		const practice = composeInstructions("practice");
		assert.notEqual(exam, practice);
		assert.ok(practice.includes("Not an exam."), "the practice doctrine is unchanged");
		assert.ok(!exam.includes("Not an exam."));
	});
});
