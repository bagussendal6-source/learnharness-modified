/**
 * CLOSE SESSION → A LIGHT NEXT SESSION. The core cut rule
 * (sessionBoundaryCutIndex) and the service entry (compactAtSessionBoundary)
 * with an injected summarizer — no LLM, no network, isolated LH_DATA_DIR.
 *
 * The laws:
 * - the cut sits at the newest closed marker: every finished session folds;
 * - a check still WAITING for its answer stays in the verbatim tail (its
 *   later answer or the warm-up's pause must find its call);
 * - nothing to fold (no closed marker, too little, already folded) → no run;
 * - the run ignores the token threshold, tags the marker "session-boundary",
 *   keeps the chat CLOSED, and the next projection carries the summary, not
 *   the old transcript;
 * - the transcript draws no extra cut divider for it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-compaction-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { compactAtSessionBoundary } = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
const { activeCompactionOf, isSessionClosed, newSessionClosedMessage, newUserMessage, projectView, sessionBoundaryCutIndex, toLlmMessages } = await import("../src/core/index.ts");
import type { LhMessage } from "../src/core/index.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const as = (m: unknown) => m as LhMessage;
const big = (label: string, kb = 20): LhMessage => newUserMessage(`${label}: ${"x".repeat(kb * 1024)}`);
const reply = (id: string, text = "ok"): LhMessage => as({ role: "assistant", id, content: [{ type: "text", text }] });
const waitingQuiz = (): LhMessage => as({ role: "assistant", id: "a_wait", content: [{ type: "toolCall", id: "wait_call", name: "quiz", arguments: { nodeId: "n", question: "Still waiting?" } }] });
const closed = () => newSessionClosedMessage({ pageNumber: 1, notes: false });

describe("sessionBoundaryCutIndex", () => {
	it("cuts at the closed marker: the whole finished session folds", () => {
		const msgs = [big("s1a"), reply("r1"), big("s1b"), reply("r2"), closed()];
		assert.equal(sessionBoundaryCutIndex(msgs), 4);
	});

	it("keeps a WAITING check in the verbatim tail", () => {
		const msgs = [big("s1a"), reply("r1"), big("s1b"), waitingQuiz(), closed()];
		assert.equal(sessionBoundaryCutIndex(msgs), 3, "the cut moves back to the question's own message");
	});

	it("no closed marker → nothing to fold", () => {
		assert.equal(sessionBoundaryCutIndex([big("a"), reply("r")]), null);
	});

	it("a tiny session is not worth a summary call", () => {
		assert.equal(sessionBoundaryCutIndex([newUserMessage("hi"), reply("r"), closed()]), null);
		assert.equal(sessionBoundaryCutIndex([newUserMessage("hi"), reply("r"), closed()], 0), 2, "the floor is the only thing stopping it");
	});
});

let calls = 0;
const deps = (thresholdTokens = 10_000_000): CompactionDeps => ({
	chatStore,
	engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
	modelId: "faux:test",
	kind: "teach",
	thresholdTokens,
	systemPromptTokens: 100,
	summarize: async () => {
		calls++;
		return {
			summary: `SESSION SUMMARY #${calls}: the learner covered limits and chain rule.`,
			usage: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
	},
});

function chatWith(messages: LhMessage[]): string {
	const chat = chatStore.createChat("Boundary");
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

describe("compactAtSessionBoundary", () => {
	it("folds the finished session even far under the token threshold, tagged as a session boundary", async () => {
		const id = chatWith([big("s1a"), reply("r1"), big("s1b"), reply("r2"), closed()]);
		const before = calls;
		await compactAtSessionBoundary(deps(), id);
		assert.equal(calls, before + 1, "one summary call");
		const record = chatStore.getChat(id)!;
		const marker = activeCompactionOf(record.messages)!;
		assert.ok(marker, "a compaction marker landed");
		assert.equal(marker.details.reason, "session-boundary");
		assert.equal(record.turns?.length ?? 0, 1, "the summary's cost is on the session's usage log");
	});

	it("the chat stays CLOSED after the marker lands (bookkeeping is not activity)", async () => {
		const id = chatWith([big("s1a"), reply("r1"), big("s1b"), reply("r2"), closed()]);
		await compactAtSessionBoundary(deps(), id);
		assert.equal(isSessionClosed(chatStore.getChat(id)!.messages), true);
	});

	it("the next session's model context is the summary — not the old transcript", async () => {
		const id = chatWith([big("OLD-SESSION-TEXT"), reply("r1"), big("more-old"), reply("r2"), closed()]);
		await compactAtSessionBoundary(deps(), id);
		const next = [...chatStore.getChat(id)!.messages, newUserMessage("new session hello")];
		const projected = JSON.stringify(toLlmMessages(next));
		assert.ok(projected.includes("SESSION SUMMARY"), "the summary rides");
		assert.ok(!projected.includes("OLD-SESSION-TEXT"), "the old session's words do not");
		assert.ok(projected.includes("new session hello"));
	});

	it("a waiting check survives into the next session's context", async () => {
		const id = chatWith([big("s1a"), reply("r1"), big("s1b"), waitingQuiz(), closed()]);
		await compactAtSessionBoundary(deps(), id);
		const projected = JSON.stringify(toLlmMessages(chatStore.getChat(id)!.messages));
		assert.ok(projected.includes("wait_call"), "the question's call is still visible to the model");
	});

	it("nothing to fold → no call, no marker", async () => {
		const id = chatWith([newUserMessage("hi"), reply("r"), closed()]);
		const before = calls;
		await compactAtSessionBoundary(deps(), id);
		assert.equal(calls, before);
		assert.equal(activeCompactionOf(chatStore.getChat(id)!.messages), null);
	});

	it("closing twice does not summarize the same span twice", async () => {
		const id = chatWith([big("s1a"), reply("r1"), big("s1b"), reply("r2"), closed()]);
		await compactAtSessionBoundary(deps(), id);
		const before = calls;
		await compactAtSessionBoundary(deps(), id);
		assert.equal(calls, before, "the second run finds nothing past the kept boundary");
	});

	it("background consent off → no run", async () => {
		const id = chatWith([big("s1a"), reply("r1"), big("s1b"), reply("r2"), closed()]);
		const before = calls;
		await compactAtSessionBoundary({ ...deps(), canStart: () => false }, id);
		assert.equal(calls, before);
	});

	it("the transcript shows no extra cut divider for a session-boundary compaction", async () => {
		const id = chatWith([big("s1a"), reply("r1"), big("s1b"), reply("r2"), closed()]);
		await compactAtSessionBoundary(deps(), id);
		const parts = projectView(chatStore.getChat(id)!.messages).flatMap((m) => m.parts.map((p) => p.type));
		assert.ok(!parts.includes("data-compaction-cut"));
		assert.ok(parts.includes("data-session-boundary"));
	});
});
