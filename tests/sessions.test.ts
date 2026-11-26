/**
 * SESSIONS INSIDE ONE CHAT (src/core/sessions.ts): which transcript rows fold
 * into which finished session, and what each session did — steps first
 * reached, checks right/answered, a warm-up opening, when. Pure: no DOM, no
 * model, no storage.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionRanges, sessionStatLine, sessionStats, viewedSession } from "../src/core/sessions.ts";
import { buildPage, buildSkippedPage, emptyDraft } from "../src/core/notes.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// ─── view rows (the folded transcript) ───────────────────────────────────────

const talk = (role: "user" | "assistant") => ({ role, parts: [{ type: "text" }] });
const label = (notes: boolean, pageNumber: number) => ({ role: "user", parts: [{ type: "data-session-boundary", data: { kind: "session-closed", notes, pageNumber } }] });
const started = () => ({ role: "user", parts: [{ type: "data-session-boundary", data: { kind: "session-started" } }] });
const card = () => ({ role: "user", parts: [{ type: "data-graph-context" }] });

describe("sessionRanges", () => {
	const rows = [talk("user"), talk("assistant"), talk("user"), label(true, 1), started(), talk("user"), talk("assistant"), label(false, 2), talk("user")];

	it("each closed session is one range, including its closed label", () => {
		const { finished } = sessionRanges(rows);
		assert.deepEqual(finished.map((f) => [f.session, f.start, f.end, f.rows, f.notes]), [
			[1, 0, 3, 3, true],
			[2, 4, 7, 2, false],
		]);
	});

	it("the current session is everything after the last closed label", () => {
		assert.deepEqual(sessionRanges(rows).current, { session: 3, start: 8 });
	});

	it("right after a close the current session is EMPTY (starts past the end)", () => {
		const closedRows = rows.slice(0, 8);
		const { finished, current } = sessionRanges(closedRows);
		assert.equal(finished.length, 2);
		assert.equal(current.start, closedRows.length, "no rows yet: the new session is a blank page");
	});

	it("marker-only rows (cards, labels) do not count as messages", () => {
		const { finished } = sessionRanges([card(), talk("user"), talk("assistant"), label(true, 1)]);
		assert.equal(finished[0]!.rows, 2);
	});

	it("no closes → one current session holding everything", () => {
		const { finished, current } = sessionRanges([talk("user"), talk("assistant")]);
		assert.deepEqual(finished, []);
		assert.deepEqual(current, { session: 1, start: 0 });
	});
});

describe("viewedSession", () => {
	const ranges = sessionRanges([talk("user"), label(true, 1), talk("user"), label(false, 2), talk("user")]);

	it("defaults to the current session, editable", () => {
		assert.deepEqual(viewedSession(ranges, null), { session: 3, start: 4, end: Number.POSITIVE_INFINITY, readOnly: false });
	});

	it("a finished session is a READ-ONLY page of its own rows", () => {
		assert.deepEqual(viewedSession(ranges, 1), { session: 1, start: 0, end: 1, readOnly: true });
		assert.deepEqual(viewedSession(ranges, 2), { session: 2, start: 2, end: 3, readOnly: true });
	});

	it("an unknown or current-session number falls back to the current session", () => {
		assert.equal(viewedSession(ranges, 99).readOnly, false);
		assert.equal(viewedSession(ranges, 3).readOnly, false);
		assert.equal(viewedSession(ranges, 0).readOnly, false);
	});
});

// ─── per-session facts ──────────────────────────────────────────────────────

const as = (m: unknown) => m as LhMessage;
let seq = 0;
const user = (id: string, t: number) => as({ role: "user", id, content: "x", timestamp: t });
const check = (node: string, correct: boolean, t: number, extra: Record<string, unknown> = {}): LhMessage[] => {
	const id = `q${++seq}`;
	return [
		as({ role: "assistant", id: `a_${id}`, timestamp: t, content: [{ type: "toolCall", id, name: "quiz", arguments: { nodeId: node } }] }),
		as({ role: "toolResult", id: `r_${id}`, timestamp: t + 1, toolCallId: id, toolName: "quiz", isError: false, details: { correct, ...extra } }),
	];
};
const tree = { nodes: ["a", "b", "c"].map((id) => ({ id, title: `Step ${id}` })), edges: [], version: 1 };
const page = (n: number, toMessageId: string) => ({ ...buildPage({ ...emptyDraft(), summary: "s" }, [], { createdAt: "2026-11-01T00:00:00.000Z", toMessageId, origin: "ai" }), n });

const T1 = Date.parse("2026-11-01T10:00:00.000Z");
const T2 = Date.parse("2026-11-04T10:00:00.000Z");

describe("sessionStats", () => {
	// Session 1: reaches a, b (b answered wrong). Session 2: re-checks a, reaches c, opens with a warm-up.
	const s1 = [user("u1", T1), ...check("a", true, T1 + 10), ...check("b", false, T1 + 20)];
	const s2 = [as({ role: "custom", id: "wb", customType: "welcome-back", content: "", display: true, details: {}, timestamp: T2 }), ...check("a", true, T2 + 10), ...check("c", true, T2 + 20)];
	const boundary1 = (s1[s1.length - 1] as { id: string }).id;
	const messages = [...s1, ...s2];

	it("one row per closed session, then the open one", () => {
		const stats = sessionStats(messages, [page(1, boundary1)], tree);
		assert.deepEqual(stats.map((s) => [s.session, s.current]), [
			[1, false],
			[2, true],
		]);
	});

	it("steps count only where they were FIRST reached", () => {
		const [one, two] = sessionStats(messages, [page(1, boundary1)], tree);
		assert.deepEqual(one!.newSteps, ["Step a", "Step b"]);
		assert.deepEqual(two!.newSteps, ["Step c"], "re-checking a is not a new step");
	});

	it("checks right / answered, per session", () => {
		const [one, two] = sessionStats(messages, [page(1, boundary1)], tree);
		assert.deepEqual([one!.correct, one!.checks], [1, 2]);
		assert.deepEqual([two!.correct, two!.checks], [2, 2]);
	});

	it("dismissed / paused checks are not answers", () => {
		const m = [user("u1", T1), ...check("a", false, T1 + 5, { dismissed: true, pausedToAsk: true })];
		const [only] = sessionStats(m, [], tree);
		assert.equal(only!.checks, 0);
	});

	it("knows which session opened with a warm-up, and when each ran", () => {
		const [one, two] = sessionStats(messages, [page(1, boundary1)], tree);
		assert.equal(one!.warmup, false);
		assert.equal(two!.warmup, true);
		assert.equal(one!.from, new Date(T1).toISOString());
		assert.equal(two!.from, new Date(T2).toISOString());
	});

	it("a session closed without notes is still a session", () => {
		const skipped = buildSkippedPage([], { createdAt: "2026-11-01T00:00:00.000Z", toMessageId: boundary1 });
		const stats = sessionStats(messages, [skipped], tree);
		assert.equal(stats[0]!.session, 1);
		assert.equal(stats[0]!.current, false);
	});

	it("no open session row when nothing happened after the last close", () => {
		const last = (messages[messages.length - 1] as { id: string }).id;
		const stats = sessionStats(messages, [page(1, boundary1), page(2, last)], tree);
		assert.ok(stats.every((s) => !s.current));
	});

	it("a boundary that vanished from the transcript is skipped, never guessed", () => {
		const stats = sessionStats(messages, [page(1, "gone")], tree);
		assert.deepEqual(stats.map((s) => s.current), [true], "only the open remainder");
	});
});

describe("sessionStatLine", () => {
	it("joins only what happened", () => {
		assert.equal(sessionStatLine({ session: 1, current: false, newSteps: ["a", "b", "c"], checks: 7, correct: 5, warmup: true, from: null, to: null }), "+3 steps · 5/7 checks · warm-up");
		assert.equal(sessionStatLine({ session: 1, current: false, newSteps: ["a"], checks: 0, correct: 0, warmup: false, from: null, to: null }), "+1 step");
		assert.equal(sessionStatLine({ session: 1, current: false, newSteps: [], checks: 0, correct: 0, warmup: false, from: null, to: null }), "");
	});
});
