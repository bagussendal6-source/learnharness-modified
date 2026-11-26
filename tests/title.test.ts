/**
 * AI session titles — the deterministic half (src/core/title.ts) and the
 * store's titleSource provenance. No LLM, no network: the namer's model call
 * (src/server/title-suggest.ts) is not exercised here; everything it DECIDES
 * is a pure function pinned below. Store assertions run under an isolated
 * LH_DATA_DIR (the chat-store-events discipline: the seam is set before any
 * config-loading import, so the store import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { TITLE_MAX_CHARS } from "../src/core/contracts/graph.ts";
import { autoTitleEligible, hasTeacherReply, needsTitle, sanitizeTitle, titleSourceOf, transcriptDigest } from "../src/core/title.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-title-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const learner = (text: string) => ({ role: "user", content: text });
const teacher = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("titleSource provenance", () => {
	it("absent reads as prompt; only prompt needs a title", () => {
		assert.equal(titleSourceOf({}), "prompt");
		assert.equal(needsTitle({}), true);
		assert.equal(needsTitle({ titleSource: "prompt" }), true);
		assert.equal(needsTitle({ titleSource: "ai" }), false);
		assert.equal(needsTitle({ titleSource: "manual" }), false);
	});

	it("a pre-titleSource record (field absent) is still eligible once the teacher replied", () => {
		assert.equal(autoTitleEligible({ messages: [learner("hi"), teacher("hello")] }), true);
	});
});

describe("auto-title gate", () => {
	it("needs a teacher reply with visible text", () => {
		assert.equal(hasTeacherReply([]), false);
		assert.equal(hasTeacherReply([learner("integral of x?")]), false);
		assert.equal(hasTeacherReply([learner("integral of x?"), teacher("   ")]), false);
		assert.equal(hasTeacherReply([learner("integral of x?"), teacher("Let's start with area.")]), true);
	});

	it("a teacher message BEFORE any learner message does not count", () => {
		assert.equal(hasTeacherReply([teacher("welcome"), learner("hi")]), false);
	});

	it("NEVER fires for a learner-chosen title, nor for an earlier AI title", () => {
		const messages = [learner("q"), teacher("a")];
		assert.equal(autoTitleEligible({ titleSource: "manual", messages }), false);
		assert.equal(autoTitleEligible({ titleSource: "ai", messages }), false);
		assert.equal(autoTitleEligible({ titleSource: "prompt", messages }), true);
	});

	it("does not fire before the teacher has replied", () => {
		assert.equal(autoTitleEligible({ titleSource: "prompt", messages: [learner("q")] }), false);
	});
});

describe("transcriptDigest", () => {
	it("labels speakers, skips non-conversational and empty messages", () => {
		const out = transcriptDigest([
			learner("What is a limit?"),
			{ role: "toolResult", content: "ignored" },
			teacher(""),
			teacher("A limit is where values head."),
		]);
		assert.equal(out, "Learner: What is a limit?\n\nTeacher: A limit is where values head.");
	});

	it("caps total size and per-message size", () => {
		const long = "x".repeat(5000);
		const out = transcriptDigest([learner(long), teacher(long), teacher(long)], 1000);
		assert.ok(out.length <= 900 * 2 + 4 + "Learner: ".length, "stops after the budget is passed");
		assert.ok(!out.includes("x".repeat(901)), "one message is clipped to 900 chars");
	});
});

describe("sanitizeTitle", () => {
	it("passes a clean title through unchanged", () => {
		assert.equal(sanitizeTitle("Teorema Green: integral garis dan lipat dua"), "Teorema Green: integral garis dan lipat dua");
	});

	it("strips quotes, markdown, label prefix and the trailing period", () => {
		assert.equal(sanitizeTitle('  "Title: **Chain rule intuition**."  '), "Chain rule intuition");
		assert.equal(sanitizeTitle("Judul: Aturan rantai"), "Aturan rantai");
		assert.equal(sanitizeTitle("# Eigenvalues and eigenvectors"), "Eigenvalues and eigenvectors");
	});

	it("keeps only the first non-empty line", () => {
		assert.equal(sanitizeTitle("\n\nBayes' theorem\nbecause it explains updating"), "Bayes' theorem");
	});

	it("clamps an over-long title at a word boundary near the cap", () => {
		const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
		const out = sanitizeTitle(long);
		assert.ok(out.length <= TITLE_MAX_CHARS + 1, `length ${out.length}`);
		assert.ok(out.endsWith("…"));
		assert.ok(!/\s…$/.test(out), "no space before the ellipsis");
	});

	it("returns empty for non-strings and for nothing-left input", () => {
		assert.equal(sanitizeTitle(undefined), "");
		assert.equal(sanitizeTitle(42), "");
		assert.equal(sanitizeTitle('  ""  '), "");
		assert.equal(sanitizeTitle("Title:"), "");
	});
});

describe("chatStore.renameChat provenance", () => {
	it("a new chat has no titleSource (reads as prompt)", () => {
		const chat = chatStore.createChat("hello world");
		assert.equal(chat.titleSource, undefined);
		assert.equal(chatStore.getChat(chat.id)?.titleSource, undefined);
	});

	it("the default rename (the learner's) stamps manual", () => {
		const chat = chatStore.createChat("a");
		const renamed = chatStore.renameChat(chat.id, "Mine");
		assert.equal(renamed.titleSource, "manual");
		assert.equal(chatStore.getChat(chat.id)?.titleSource, "manual");
	});

	it("the namer's rename stamps ai, and rides the list summary", () => {
		const chat = chatStore.createChat("b");
		chatStore.renameChat(chat.id, "Named by model", "ai");
		const summary = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(summary?.title, "Named by model");
		assert.equal(summary?.titleSource, "ai");
	});

	it("a rename does not bump updatedAt (sidebar order never churns)", () => {
		const chat = chatStore.createChat("c");
		const before = chatStore.getChat(chat.id)!.updatedAt;
		chatStore.renameChat(chat.id, "Renamed", "ai");
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, before);
	});

	it("bulk filter: only sessions still on their prompt title are selected", () => {
		const a = chatStore.createChat("untouched");
		const b = chatStore.createChat("will be ai");
		const c = chatStore.createChat("will be manual");
		chatStore.renameChat(b.id, "AI title", "ai");
		chatStore.renameChat(c.id, "My title");
		const ids = chatStore.listChats().filter(needsTitle).map((s) => s.id);
		assert.ok(ids.includes(a.id));
		assert.ok(!ids.includes(b.id));
		assert.ok(!ids.includes(c.id));
	});
});
