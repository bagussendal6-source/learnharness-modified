/**
 * SESSION BOUNDARIES — the closed marker, the pause of a waiting check, and the
 * state the Start panel keys on (src/core/native-messages.ts, input-events.ts,
 * view.ts). Pure: no LLM, no network. Pinned decisions (owner, 2026-11-08): a
 * closed session shows a compact label (never a rule), hides the question that
 * was waiting until the next session starts, the teacher never reads the
 * markers, and starting — by warm-up or by typing — pauses that check.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputAppends } from "../src/core/input-events.ts";
import {
	isSessionClosed,
	nativeInputCause,
	newSessionClosedMessage,
	newSessionStartedMessage,
	newUserMessage,
	newWelcomeBackMessage,
	toLlmMessages,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

const as = (m: unknown) => m as LhMessage;
const waitingQuiz: LhMessage[] = [
	as({ role: "user", id: "u1", content: "teach me" }),
	as({ role: "assistant", id: "a1", content: [{ type: "toolCall", id: "qq", name: "quiz", arguments: { nodeId: "n1", question: "Which rule applies?" } }] }),
];
const closed = () => newSessionClosedMessage({ pageNumber: 2, notes: true });

describe("isSessionClosed", () => {
	it("true only when the closed marker is the newest message", () => {
		assert.equal(isSessionClosed([...waitingQuiz, closed()]), true);
		assert.equal(isSessionClosed(waitingQuiz), false);
		assert.equal(isSessionClosed([]), false);
	});

	it("ends the moment anything follows it — a started marker, a message, a warm-up", () => {
		assert.equal(isSessionClosed([...waitingQuiz, closed(), newSessionStartedMessage()]), false);
		assert.equal(isSessionClosed([...waitingQuiz, closed(), newUserMessage("hi")]), false);
		assert.equal(isSessionClosed([...waitingQuiz, closed(), newWelcomeBackMessage("[Welcome back]", {})]), false);
	});
});

describe("the teacher never reads the boundary markers", () => {
	it("toLlmMessages drops both", () => {
		const out = toLlmMessages([...waitingQuiz, closed(), newSessionStartedMessage(), newUserMessage("hello")]);
		const text = JSON.stringify(out);
		assert.ok(!text.includes("session-closed"));
		assert.ok(!text.includes("session-started"));
		assert.ok(text.includes("hello"));
	});

	it("they are neutral input, never a learner or automatic cause", () => {
		assert.equal(nativeInputCause(closed() as never, []), "neutral");
		assert.equal(nativeInputCause(newSessionStartedMessage() as never, []), "neutral");
	});
});

describe("the transcript shows one compact label", () => {
	it("projects to a boundary part carrying the page and whether notes were written", () => {
		const view = projectView([closed()]);
		assert.equal(view.length, 1);
		const part = view[0]!.parts[0] as { type: string; data: { kind: string; pageNumber: number; notes: boolean } };
		assert.equal(part.type, "data-session-boundary");
		assert.deepEqual(part.data, { kind: "session-closed", pageNumber: 2, notes: true });
	});

	it("a started marker projects too", () => {
		const part = projectView([newSessionStartedMessage()])[0]!.parts[0] as { type: string; data: { kind: string } };
		assert.equal(part.type, "data-session-boundary");
		assert.equal(part.data.kind, "session-started");
	});
});

describe("starting the next session pauses the check that was waiting", () => {
	const record = (messages: LhMessage[]) => ({ messages, kind: undefined as string | undefined });

	it("the warm-up pauses a waiting check BEFORE its own marker, in the learner's own 'ask first' vocabulary", () => {
		const marker = newWelcomeBackMessage("[Welcome back] brief", {});
		const appends = inputAppends(record(waitingQuiz), { type: "warmup", marker });
		assert.equal(appends.length, 2);
		const pause = appends[0] as unknown as { role: string; toolCallId: string; details: { dismissed: boolean; pausedToAsk: boolean; questionText: string } };
		assert.equal(pause.role, "toolResult");
		assert.equal(pause.toolCallId, "qq");
		assert.equal(pause.details.dismissed, true);
		assert.equal(pause.details.pausedToAsk, true);
		assert.equal(pause.details.questionText, "Which rule applies?");
		assert.equal(appends[1], marker);
	});

	it("the model reads the pause as 'pose it again', not as a skip or a wrong answer", () => {
		const marker = newWelcomeBackMessage("[Welcome back] brief", {});
		const appends = inputAppends(record(waitingQuiz), { type: "warmup", marker });
		const text = JSON.stringify((appends[0] as unknown as { content: unknown }).content);
		assert.ok(text.includes("pose the same check again"));
		assert.ok(text.includes("NOT a skip"));
	});

	it("no waiting check → the warm-up appends just its marker", () => {
		const marker = newWelcomeBackMessage("brief", {});
		const answered = [...waitingQuiz, as({ role: "toolResult", id: "r1", toolCallId: "qq", toolName: "quiz", isError: false, content: [{ type: "text", text: "{}" }] })];
		assert.deepEqual(inputAppends(record(answered), { type: "warmup", marker }), [marker]);
	});

	it("typing into a CLOSED session pauses the waiting check, then the message", () => {
		const appends = inputAppends(record([...waitingQuiz, closed()]), { type: "text", text: "wait, first a question" });
		assert.equal(appends.length, 2);
		assert.equal((appends[0] as unknown as { toolCallId: string }).toolCallId, "qq");
		assert.equal((appends[1] as unknown as { role: string }).role, "user");
	});

	it("typing into an OPEN session is untouched (no pause appended)", () => {
		const appends = inputAppends(record(waitingQuiz), { type: "text", text: "hi" });
		assert.equal(appends.length, 1);
	});

	it("typing into a closed session with nothing waiting is just the message", () => {
		const clean = [as({ role: "user", id: "u1", content: "x" }), as({ role: "assistant", id: "a1", content: [{ type: "text", text: "ok" }] }), closed()];
		assert.equal(inputAppends(record(clean), { type: "text", text: "hi" }).length, 1);
	});
});
