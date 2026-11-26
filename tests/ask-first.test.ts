/**
 * "Ask first": a check the learner paused to ask something. The teacher is told
 * it is NOT a skip (answer, then pose the same check again), the record keeps the
 * reason, and a backup affordance exists while the teacher has not re-posed it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactAnswerForModel, dismissedAnswer, PAUSED_TO_ASK_NOTE } from "../src/core/question-core.ts";
import { pausedQuestionToReask } from "../src/core/pending.ts";
import { dismissAppends, parseDismissInput } from "../src/core/input-events.ts";
import { newAnswerResult } from "../src/core/native-messages.ts";

describe("pausedToAsk answers", () => {
	it("a plain skip is unchanged for the teacher", () => {
		const skip = dismissedAnswer("quiz", "Q?");
		assert.equal(skip.pausedToAsk, undefined);
		assert.deepEqual(compactAnswerForModel(skip), { kind: "quiz", dismissed: true });
	});

	it("a pause tells the teacher to answer and pose the same check again", () => {
		const paused = dismissedAnswer("quiz", "Q?", { pausedToAsk: true });
		assert.equal(paused.dismissed, true);
		assert.equal(paused.pausedToAsk, true);
		assert.deepEqual(compactAnswerForModel(paused), { kind: "quiz", dismissed: true, pausedToAsk: true, instruction: PAUSED_TO_ASK_NOTE });
		assert.match(PAUSED_TO_ASK_NOTE, /NOT a skip/);
		assert.match(PAUSED_TO_ASK_NOTE, /pose the same check again/);
	});

	it("survives the dismissal route: parse, append, and the tool result the model reads", () => {
		const answer = dismissedAnswer("quiz", "Q?", { pausedToAsk: true });
		const input = parseDismissInput({ type: "dismiss", toolCallId: "call_1", answer });
		const record = {
			messages: [
				{ id: "m1", role: "user", content: "teach me", timestamp: 1 },
				{ id: "m2", role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "quiz", arguments: { question: "Q?" } }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
			],
		};
		const [result] = dismissAppends(record as never, input) as unknown as { content: { text: string }[]; details: { pausedToAsk?: boolean } }[];
		assert.equal(result!.details.pausedToAsk, true);
		const seen = JSON.parse(result!.content[0]!.text);
		assert.equal(seen.pausedToAsk, true);
		assert.equal(seen.instruction, PAUSED_TO_ASK_NOTE);
		assert.equal((newAnswerResult("call_1", "quiz", answer).details as { pausedToAsk?: boolean }).pausedToAsk, true);
	});
});

describe("pausedQuestionToReask (the backup button)", () => {
	const tool = (type: string, toolCallId: string, output?: unknown) => ({ type, toolCallId, ...(output ? { output } : {}) });
	const paused = { dismissed: true, pausedToAsk: true, questionText: "Which is true?" };
	const msg = (role: string, ...parts: ReturnType<typeof tool>[]) => ({ role, parts: parts.length ? parts : [{ type: "text" } as never] });

	it("offers the question while it is still paused and not re-posed", () => {
		const messages = [msg("assistant", tool("tool-quiz", "c1", paused)), msg("assistant", { type: "text" } as never)];
		assert.deepEqual(pausedQuestionToReask(messages as never), { toolCallId: "c1", question: "Which is true?" });
	});

	it("stops offering once the teacher re-posed it, pending or answered", () => {
		const rePosed = [msg("assistant", tool("tool-quiz", "c1", paused)), msg("assistant", tool("tool-quiz", "c2"))];
		assert.equal(pausedQuestionToReask(rePosed as never), null);
		const answered = [msg("assistant", tool("tool-quiz", "c1", paused)), msg("assistant", tool("tool-quiz", "c2", { dismissed: false, kind: "quiz" }))];
		assert.equal(pausedQuestionToReask(answered as never), null);
	});

	it("never offers for a plain skip, or when there are no questions", () => {
		assert.equal(pausedQuestionToReask([msg("assistant", tool("tool-quiz", "c1", { dismissed: true }))] as never), null);
		assert.equal(pausedQuestionToReask([] as never), null);
		assert.equal(pausedQuestionToReask([msg("assistant", tool("tool-research", "r1", paused))] as never), null);
	});
});
