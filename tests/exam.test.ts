/**
 * The FINAL EXAM — coverage, grading, completion, the status line
 * (src/core/exam.ts). Pure: no LLM, no network. Pinned decisions (owner,
 * 2026-11-06): the plan counts as covered when every node was reached by a
 * tagged check; the scale is A>=90 B>=80 C>=70 D>=60; the pass mark is B; the
 * BEST finished attempt decides; below the mark the line reads
 * "All plan clear · Exam not passed … need retest!".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	completionLine,
	completionOf,
	examContextMessage,
	gradeOf,
	PASS_PERCENT,
	percentPasses,
	planCoverage,
	scoreExam,
	type ExamAttempt,
	type ExamResult,
} from "../src/core/exam.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const tree = (ids: string[]) => ({ nodes: ids.map((id) => ({ id, title: id })), edges: [], version: 1 });

let seq = 0;
const asLh = (m: unknown) => m as LhMessage;
const quiz = (nodeId: string): LhMessage[] => {
	const id = `q${++seq}`;
	return [
		asLh({ role: "assistant", id: `a${id}`, content: [{ type: "toolCall", id, name: "quiz", arguments: { nodeId } }] }),
		asLh({ role: "toolResult", id: `r${id}`, toolCallId: id, toolName: "quiz", isError: false, details: {} }),
	];
};

/** One posed + concluded exam problem (clean results both). */
const problem = (outcome: string, target?: string[], opts: { concludeError?: boolean } = {}): LhMessage[] => {
	const p = `p${++seq}`;
	const c = `c${seq}`;
	return [
		asLh({ role: "assistant", id: `ap${p}`, content: [{ type: "toolCall", id: p, name: "problem", arguments: { statement: "s", mode: "recall", modelSolution: "m", ...(target ? { target } : {}) } }] }),
		asLh({ role: "toolResult", id: `rp${p}`, toolCallId: p, toolName: "problem", isError: false }),
		asLh({ role: "assistant", id: `ac${c}`, content: [{ type: "toolCall", id: c, name: "conclude", arguments: { outcome, verdict: "v", rung: null, missClass: null, retest: false } }] }),
		asLh({ role: "toolResult", id: `rc${c}`, toolCallId: c, toolName: "conclude", isError: opts.concludeError === true }),
	];
};

describe("grade scale and pass mark", () => {
	it("A>=90, B>=80, C>=70, D>=60, else E — on the boundaries", () => {
		assert.deepEqual([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(gradeOf), ["A", "A", "B", "B", "C", "C", "D", "D", "E", "E"]);
	});

	it("the pass mark is B (80%)", () => {
		assert.equal(PASS_PERCENT, 80);
		assert.equal(percentPasses(80), true);
		assert.equal(percentPasses(79), false);
	});
});

describe("planCoverage", () => {
	it("no plan / empty plan is never complete", () => {
		assert.equal(planCoverage(null, []).complete, false);
		assert.equal(planCoverage(tree([]), []).complete, false);
	});

	it("counts the CURRENT node too — visited alone could never complete a plan", () => {
		const t = tree(["a", "b", "c"]);
		const msgs = [...quiz("a"), ...quiz("b"), ...quiz("c")]; // c is current, a and b visited
		const cov = planCoverage(t, msgs);
		assert.deepEqual(cov, { total: 3, covered: 3, complete: true });
	});

	it("a node never reached keeps the plan incomplete", () => {
		const cov = planCoverage(tree(["a", "b", "c"]), [...quiz("a"), ...quiz("b")]);
		assert.equal(cov.covered, 2);
		assert.equal(cov.complete, false);
	});

	it("a rewritten plan is judged by its CURRENT nodes (a dropped node no longer counts)", () => {
		const msgs = [...quiz("a"), ...quiz("b")];
		assert.equal(planCoverage(tree(["a", "b"]), msgs).complete, true);
		assert.equal(planCoverage(tree(["a", "b", "new"]), msgs).complete, false);
		assert.equal(planCoverage(tree(["b"]), msgs).complete, true);
	});
});

describe("scoreExam", () => {
	it("solved = 1, solvedWithHints = 0.5, anything else = 0; scored over the FIXED total", () => {
		const msgs = [...problem("solved"), ...problem("solvedWithHints"), ...problem("movedOn"), ...problem("surrendered")];
		const r = scoreExam(msgs, 4);
		assert.equal(r.points, 1.5);
		assert.equal(r.percent, 38);
		assert.equal(r.grade, "E");
		assert.equal(r.concluded, 4);
		assert.equal(r.finished, true);
		assert.equal(r.passed, false);
	});

	it("an UNFINISHED exam never passes, however well it is going", () => {
		const r = scoreExam([...problem("solved"), ...problem("solved")], 8);
		assert.equal(r.concluded, 2);
		assert.equal(r.finished, false);
		assert.equal(r.percent, 25, "2 of 8, not 2 of 2");
		assert.equal(r.passed, false);
	});

	it("passes at 80% exactly, fails at 75%", () => {
		const eight = (n: number) => Array.from({ length: 8 }, (_, i) => problem(i < n ? "solved" : "surrendered")).flat();
		assert.equal(scoreExam(eight(8), 8).passed, true);
		const six = scoreExam(eight(6), 8);
		assert.equal(six.percent, 75);
		assert.equal(six.passed, false);
		assert.equal(scoreExam(eight(7), 8).percent, 88);
		assert.equal(scoreExam(eight(7), 8).grade, "B");
	});

	it("a dismissed problem counts as concluded with 0 points", () => {
		const r = scoreExam([...problem("dismissed"), ...problem("solved")], 2);
		assert.equal(r.concluded, 2);
		assert.equal(r.points, 1);
	});

	it("a REFUSED conclude (errored result) never happened", () => {
		const r = scoreExam([...problem("solved", undefined, { concludeError: true })], 1);
		assert.equal(r.concluded, 0);
		assert.equal(r.finished, false);
	});

	it("problems beyond the exam length are ignored", () => {
		const r = scoreExam([...problem("solved"), ...problem("solved"), ...problem("solved")], 2);
		assert.equal(r.concluded, 2);
		assert.equal(r.points, 2);
		assert.equal(r.percent, 100);
	});

	it("breaks the score down per proposition (for 'review these next')", () => {
		const r = scoreExam([...problem("solved", ["n1", "n2"]), ...problem("surrendered", ["n2"]), ...problem("solved")], 3);
		const byId = Object.fromEntries(r.perProposition.map((p) => [p.id, p]));
		assert.deepEqual(byId.n1, { id: "n1", points: 1, of: 1 });
		assert.deepEqual(byId.n2, { id: "n2", points: 1, of: 2 });
		assert.equal(r.perProposition.length, 2, "an untagged problem lands in no row");
	});

	it("no problems, no total: zeros, never a pass", () => {
		const r = scoreExam([], 0);
		assert.equal(r.finished, false);
		assert.equal(r.passed, false);
		assert.equal(r.percent, 0);
	});
});

describe("completion (a fold over exam attempts)", () => {
	const covered = { total: 3, covered: 3, complete: true };
	const open = { total: 3, covered: 2, complete: false };
	const result = (percent: number, finished = true): ExamResult => ({
		total: 8,
		concluded: finished ? 8 : 3,
		finished,
		points: (percent / 100) * 8,
		percent,
		grade: gradeOf(percent),
		passed: finished && percentPasses(percent),
		perProposition: [],
	});
	const attempt = (id: string, percent: number, finished = true): ExamAttempt => ({ examChatId: id, at: "2026-11-06T00:00:00.000Z", result: result(percent, finished) });

	it("not covered → no status line", () => {
		const c = completionOf(open, []);
		assert.equal(c.status, "not-covered");
		assert.equal(completionLine(c), null);
	});

	it("covered, no exam yet → ready (offer the exam)", () => {
		const c = completionOf(covered, []);
		assert.equal(c.status, "ready");
		assert.equal(completionLine(c), "All plan clear — take the final exam.");
	});

	it("an unfinished attempt is not an exam result", () => {
		assert.equal(completionOf(covered, [attempt("e1", 100, false)]).status, "ready");
	});

	it("below the pass mark: plan clear, exam NOT passed, retest needed", () => {
		const c = completionOf(covered, [attempt("e1", 72)]);
		assert.equal(c.status, "not-passed");
		assert.equal(completionLine(c), "All plan clear · Exam not passed (best C, 72%) — need retest!");
	});

	it("at/above the pass mark: completed, with the grade", () => {
		const c = completionOf(covered, [attempt("e1", 88)]);
		assert.equal(c.status, "completed");
		assert.equal(completionLine(c), "Completed · B (88%)");
	});

	it("the BEST finished attempt decides — a later worse attempt never takes a pass away", () => {
		const c = completionOf(covered, [attempt("e1", 88), attempt("e2", 50)]);
		assert.equal(c.status, "completed");
		assert.equal(c.best!.examChatId, "e1");
	});

	it("a retest that passes upgrades not-passed to completed", () => {
		assert.equal(completionOf(covered, [attempt("e1", 60)]).status, "not-passed");
		const c = completionOf(covered, [attempt("e1", 60), attempt("e2", 90)]);
		assert.equal(c.status, "completed");
		assert.equal(completionLine(c), "Completed · A (90%)");
	});

	it("a plan that grew after the exam is no longer covered", () => {
		assert.equal(completionOf(open, [attempt("e1", 95)]).status, "not-covered");
	});
});

describe("examContextMessage", () => {
	it("prepends the exam terms; keeps the graph-context card payload", () => {
		const picks = [{ id: "n1", name: "Chain rule", statement: "d(f∘g)=f'(g)g'" }];
		const msg = examContextMessage({ parentChatId: "chat_x", total: 8 }, "Calculus", picks, ["a → b"]);
		const content = msg.content as string;
		assert.ok(content.startsWith("[Exam]"));
		assert.ok(content.includes("exactly 8 problems"));
		assert.ok(content.includes("80%"));
		assert.ok(content.includes("[n1] Chain rule"), "target ids still listed");
		assert.equal(msg.customType, "graph-context");
		assert.deepEqual((msg.details as { propositions: unknown }).propositions, picks);
	});
});
