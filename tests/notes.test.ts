/**
 * Session NOTES — the pure core (src/core/notes.ts) and the append-only store
 * (src/store/notes.ts). No LLM, no network: the model call (src/server/notes.ts)
 * is not exercised; everything it relies on is pinned here — numbering and
 * continuity across pages, reference validation, the open-session boundary,
 * the quiz-derived struggle signals, the prompt builder, rendering, and the
 * "earlier pages are never touched" law. Store assertions run under an
 * isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import {
	buildPage,
	buildSkippedPage,
	draftHasContent,
	elideMiddle,
	emptyDraft,
	emptyNotes,
	lastMessageId,
	maxConceptNumber,
	newestWrittenPage,
	normalizeDraft,
	notesPrompt,
	openSessionSlice,
	pageBoundaryProblem,
	previewPage,
	previousNotesDigest,
	renderNotesMarkdown,
	renderPageMarkdown,
	sliceHasLearnerActivity,
	struggleSignals,
	validateDraft,
	type NotePage,
	type NotesDraft,
} from "../src/core/notes.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { notesStore } = await import("../src/store/notes.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const draft = (over: Partial<NotesDraft> = {}): NotesDraft => ({ ...emptyDraft(), summary: "s", ...over });
const concept = (title: string, refs: number[] = []) => ({ title, body: `${title} body`, refs });
const meta = (toMessageId: string) => ({ createdAt: "2026-11-01T10:00:00.000Z", toMessageId, origin: "ai" as const });

const msg = (role: string, id: string, extra: Record<string, unknown> = {}) => ({ role, id, content: [], ...extra }) as unknown as LhMessage;

describe("normalizeDraft", () => {
	it("trims, drops incomplete entries, dedupes refs, never throws", () => {
		const d = normalizeDraft({
			summary: "  hello ",
			concepts: [{ title: " A ", body: " b ", refs: [2, 2, "x", 0, -1, 1.5, 3] }, { title: "no body", body: "" }, null],
			rules: ["  r ", "", 5],
			misconceptions: [{ believed: "x", whyWrong: "", correct: "y" }, { believed: "", correct: "y" }],
			corrections: [{ corrects: 2, text: "t" }, { corrects: 0, text: "t" }, { corrects: 1, text: "" }],
		});
		assert.equal(d.summary, "hello");
		assert.deepEqual(d.concepts, [{ title: "A", body: "b", refs: [2, 3] }]);
		assert.deepEqual(d.rules, ["r"]);
		assert.equal(d.misconceptions.length, 1);
		assert.deepEqual(d.corrections, [{ corrects: 2, text: "t" }]);
	});

	it("garbage in → an empty draft", () => {
		assert.equal(draftHasContent(normalizeDraft(undefined)), false);
		assert.equal(draftHasContent(normalizeDraft("nope")), false);
		assert.equal(draftHasContent(normalizeDraft({ concepts: "x" })), false);
	});
});

describe("numbering + continuity across pages", () => {
	it("numbers concepts from 1, then continues where the last page stopped", () => {
		const p1 = buildPage(draft({ concepts: [concept("Limit"), concept("Continuity")] }), [], meta("m2"));
		assert.deepEqual(p1.concepts.map((c) => c.n), [1, 2]);
		assert.equal(p1.n, 1);
		const p2 = buildPage(draft({ concepts: [concept("Derivative", [1, 2]), concept("Slope")] }), [p1], meta("m5"));
		assert.deepEqual(p2.concepts.map((c) => c.n), [3, 4]);
		assert.equal(p2.n, 2);
		assert.deepEqual(p2.concepts[0]!.refs, [1, 2]);
		assert.equal(maxConceptNumber([p1, p2]), 4);
	});

	it("a page with no concepts does not advance the numbering", () => {
		const p1 = buildPage(draft({ concepts: [concept("A")] }), [], meta("m1"));
		const p2 = buildPage(draft({ stuck: ["got stuck on A"] }), [p1], meta("m2"));
		const p3 = buildPage(draft({ concepts: [concept("B")] }), [p1, p2], meta("m3"));
		assert.equal(p3.concepts[0]!.n, 2);
	});
});

describe("validateDraft", () => {
	const p1 = buildPage(draft({ concepts: [concept("A"), concept("B")] }), [], meta("m1"));

	it("refuses an empty page", () => {
		assert.match(validateDraft(emptyDraft(), [p1])!, /empty/i);
	});

	it("refs may only point at EARLIER pages' concepts", () => {
		assert.equal(validateDraft(draft({ concepts: [concept("C", [1, 2])] }), [p1]), null);
		assert.match(validateDraft(draft({ concepts: [concept("C", [3])] }), [p1])!, /refs 3/);
		assert.match(validateDraft(draft({ concepts: [concept("C", [1])] }), [])!, /refs 1/, "no earlier pages: nothing to ref");
	});

	it("corrections must target an existing earlier concept", () => {
		assert.equal(validateDraft(draft({ corrections: [{ corrects: 2, text: "fix" }] }), [p1]), null);
		assert.match(validateDraft(draft({ corrections: [{ corrects: 9, text: "fix" }] }), [p1])!, /concept 9/);
	});

	it("buildPage throws on an invalid draft", () => {
		assert.throws(() => buildPage(draft({ concepts: [concept("C", [7])] }), [p1], meta("m2")), /refs 7/);
	});
});

describe("the open session boundary", () => {
	const messages = [msg("user", "m1"), msg("assistant", "m2"), msg("toolResult", "m3"), msg("assistant", "m4"), msg("user", "m5")];

	it("no pages: the whole transcript is the open session", () => {
		const slice = openSessionSlice(messages, [])!;
		assert.equal(slice.messages.length, 5);
		assert.equal(slice.fromIndex, 0);
	});

	it("after a page: only what follows its boundary message", () => {
		const page = buildPage(draft({ concepts: [concept("A")] }), [], meta("m2"));
		const slice = openSessionSlice(messages, [page])!;
		assert.deepEqual(slice.messages.map((m) => (m as { id: string }).id), ["m3", "m4", "m5"]);
		assert.equal(slice.fromIndex, 2);
	});

	it("a vanished boundary id → null (refuse, never guess)", () => {
		const page = buildPage(draft({ concepts: [concept("A")] }), [], meta("gone"));
		assert.equal(openSessionSlice(messages, [page]), null);
	});

	it("learner activity = a user message or a tool result (an answer)", () => {
		assert.equal(sliceHasLearnerActivity([msg("assistant", "a")]), false);
		assert.equal(sliceHasLearnerActivity([]), false);
		assert.equal(sliceHasLearnerActivity([msg("assistant", "a"), msg("user", "b")]), true);
		assert.equal(sliceHasLearnerActivity([msg("toolResult", "r")]), true);
	});

	it("lastMessageId reads the final message's id", () => {
		assert.equal(lastMessageId(messages), "m5");
		assert.equal(lastMessageId([]), null);
	});

	it("pageBoundaryProblem: a stale draft or an empty close is refused", () => {
		assert.equal(pageBoundaryProblem(messages, [], "m5"), null);
		assert.match(pageBoundaryProblem(messages, [], "nope")!, /out of date/);
		const page = buildPage(draft({ concepts: [concept("A")] }), [], meta("m5"));
		// the session was already closed through m5: saving the same boundary again is stale
		assert.match(pageBoundaryProblem(messages, [page], "m5")!, /out of date/);
		// a close with only teacher output after the boundary has nothing new
		const more = [...messages, msg("assistant", "m6")];
		assert.match(pageBoundaryProblem(more, [page], "m6")!, /Nothing new/);
	});
});

describe("struggleSignals (derived from the quiz answers, no model)", () => {
	const tree = { nodes: [{ id: "n1", title: "Chain rule" }, { id: "n2", title: "Composites" }], edges: [], version: 1 };
	const call = (id: string, nodeId: string) => msg("assistant", `a_${id}`, { content: [{ type: "toolCall", id, name: "quiz", arguments: { nodeId } }] });
	const result = (id: string, details: Record<string, unknown>) => msg("toolResult", `r_${id}`, { toolName: "quiz", toolCallId: id, details });

	it("classifies per the confidence doctrine and ranks worst-first", () => {
		const messages = [
			call("c1", "n1"), result("c1", { questionText: "Q-fragile", correct: true, confidence: 30 }),
			call("c2", "n2"), result("c2", { questionText: "Q-wrong-sure", correct: false, confidence: 90 }),
			call("c3", "n1"), result("c3", { questionText: "Q-dk", dontKnow: true, correct: false }),
			call("c4", "n1"), result("c4", { questionText: "Q-wrong-unsure", correct: false, confidence: 40 }),
			call("c5", "n1"), result("c5", { questionText: "Q-solid", correct: true, confidence: 95 }),
		];
		const out = struggleSignals(messages, tree);
		assert.deepEqual(out.map((s) => s.kind), ["committed-misconception", "dont-know", "wrong", "fragile"]);
		assert.equal(out[0]!.node, "Composites");
		assert.equal(out[0]!.confidence, 90);
		assert.ok(!out.some((s) => s.question === "Q-solid"), "a confident right answer is not a signal");
	});

	it("skips dismissed checks and answers with no question text", () => {
		const messages = [
			call("c1", "n1"), result("c1", { questionText: "Q", dismissed: true, correct: false }),
			call("c2", "n1"), result("c2", { questionText: "", correct: false }),
		];
		assert.deepEqual(struggleSignals(messages, tree), []);
	});

	it("an unknown nodeId carries no node title; no tree is fine", () => {
		const messages = [call("c1", "ghost"), result("c1", { questionText: "Q", correct: false, confidence: 80 })];
		assert.equal(struggleSignals(messages, tree)[0]!.node, undefined);
		assert.equal(struggleSignals(messages, null).length, 1);
	});
});

describe("prompt + digest", () => {
	const p1 = buildPage(draft({ concepts: [concept("Limit"), concept("Continuity")], rules: ["lim f = L"] }), [], meta("m1"));

	it("the prompt carries earlier pages, the highest concept number, signals and the transcript", () => {
		const prompt = notesPrompt({
			title: "Calculus",
			tree: { nodes: [{ id: "n1", title: "Limits", summary: "what a limit is" }], edges: [], version: 1 },
			pages: [p1],
			signals: [{ kind: "committed-misconception", question: "Is 0.999… < 1?", confidence: 90, node: "Limits" }],
			transcript: "Learner: hi",
		});
		assert.ok(prompt.includes("## Page 1"));
		assert.ok(prompt.includes("1. Limit"));
		assert.ok(prompt.includes("Highest concept number so far: 2"));
		assert.ok(prompt.includes("confidently WRONG"));
		assert.ok(prompt.includes("90% sure"));
		assert.ok(prompt.includes("Is 0.999… < 1?"));
		assert.ok(prompt.includes("Learner: hi"));
	});

	it("first page: says so, highest number 0", () => {
		const prompt = notesPrompt({ title: "T", tree: null, pages: [], signals: [], transcript: "x" });
		assert.ok(prompt.includes("this is the first page"));
		assert.ok(prompt.includes("Highest concept number so far: 0"));
		assert.ok(prompt.includes("(none recorded)"));
	});

	it("over budget: older pages shrink to titles, the newest stays in full", () => {
		const big = (n: number): NotePage => ({ ...p1, n, concepts: [{ n, title: `T${n}`, body: "x".repeat(2000), refs: [] }] });
		const pages = [big(1), big(2), big(3)];
		const digest = previousNotesDigest(pages, 3000);
		assert.ok(digest.includes("Page 1 (titles only)"));
		assert.ok(digest.includes("1. T1"));
		assert.ok(digest.includes("## Page 3 —"), "newest page rendered in full");
	});

	it("elideMiddle keeps head and tail and marks the cut", () => {
		const text = `${"a".repeat(500)}${"b".repeat(500)}`;
		const out = elideMiddle(text, 400);
		assert.ok(out.startsWith("aaa"));
		assert.ok(out.endsWith("bbb"));
		assert.ok(out.includes("omitted"));
		assert.equal(elideMiddle("short", 400), "short");
	});
});

describe("rendering", () => {
	it("one fixed section order; empty sections vanish; own words last", () => {
		const page = buildPage(
			draft({
				summary: "Did limits.",
				concepts: [concept("Limit", [])],
				rules: ["R"],
				stuck: ["S"],
				misconceptions: [{ believed: "b", whyWrong: "w", correct: "c" }],
				open: ["O"],
			}),
			[],
			meta("m1"),
		);
		const md = renderPageMarkdown({ ...page, own: "my words" });
		const at = (h: string) => md.indexOf(`### ${h}`);
		assert.ok(at("Learned") < at("Rules & formulas"));
		assert.ok(at("Rules & formulas") < at("Where I got stuck"));
		assert.ok(at("Where I got stuck") < at("Misconceptions"));
		assert.ok(at("Misconceptions") < at("Open questions"));
		assert.ok(at("Open questions") < at("In my own words"));
		assert.equal(at("Worked examples"), -1, "an empty section is omitted");
		assert.ok(md.includes("**1. Limit**"));
	});

	it("the document: header + every page in order; empty is explicit", () => {
		assert.ok(renderNotesMarkdown(emptyNotes("c"), "T").includes("No pages yet"));
		const p1 = buildPage(draft({ concepts: [concept("A")] }), [], meta("m1"));
		const p2 = buildPage(draft({ concepts: [concept("B")] }), [p1], meta("m2"));
		const md = renderNotesMarkdown({ ...emptyNotes("c"), pages: [p1, p2] }, "Calc");
		assert.ok(md.startsWith("# Calc — notes"));
		assert.ok(md.indexOf("## Page 1") < md.indexOf("## Page 2"));
		assert.ok(md.includes("**2. B**"));
	});
});

describe("notesStore (append-only)", () => {
	it("no notes → null; appendPage creates and persists", () => {
		assert.equal(notesStore.readNotes("chat_a"), null);
		const p1 = buildPage(draft({ concepts: [concept("A")] }), [], meta("m1"));
		const rec = notesStore.appendPage("chat_a", p1);
		assert.equal(rec.pages.length, 1);
		assert.equal(notesStore.readNotes("chat_a")!.pages[0]!.concepts[0]!.title, "A");
	});

	it("refuses a page that is not exactly the next one", () => {
		const p1 = buildPage(draft({ concepts: [concept("A")] }), [], meta("m1"));
		notesStore.appendPage("chat_b", p1);
		assert.throws(() => notesStore.appendPage("chat_b", p1), /not the next page/);
		const skipped = { ...buildPage(draft({ concepts: [concept("B")] }), [p1], meta("m2")), n: 5 };
		assert.throws(() => notesStore.appendPage("chat_b", skipped), /not the next page/);
	});

	it("earlier pages are byte-identical after a later page is appended", () => {
		const p1 = buildPage(draft({ concepts: [concept("A")], rules: ["r"] }), [], meta("m1"));
		notesStore.appendPage("chat_c", p1);
		const before = JSON.stringify(notesStore.readNotes("chat_c")!.pages[0]);
		const p2 = buildPage(draft({ concepts: [concept("B", [1])] }), notesStore.readNotes("chat_c")!.pages, meta("m2"));
		notesStore.appendPage("chat_c", p2);
		assert.equal(JSON.stringify(notesStore.readNotes("chat_c")!.pages[0]), before);
		assert.equal(notesStore.readNotes("chat_c")!.pages[1]!.concepts[0]!.n, 2);
	});

	it("setOwn changes only the own-words field of that page", () => {
		const p1 = buildPage(draft({ concepts: [concept("A")] }), [], meta("m1"));
		notesStore.appendPage("chat_d", p1);
		const rec = notesStore.setOwn("chat_d", 1, "  in my words ");
		assert.equal(rec.pages[0]!.own, "in my words");
		assert.deepEqual({ ...rec.pages[0]!, own: "" }, { ...p1, own: "" });
		assert.throws(() => notesStore.setOwn("chat_d", 9, "x"), /not found/);
	});

	it("deleteNotes removes the file; a second delete reports false", () => {
		const p1 = buildPage(draft({ concepts: [concept("A")] }), [], meta("m1"));
		notesStore.appendPage("chat_e", p1);
		assert.equal(notesStore.deleteNotes("chat_e"), true);
		assert.equal(notesStore.readNotes("chat_e"), null);
		assert.equal(notesStore.deleteNotes("chat_e"), false);
	});

	it("an invalid chat id never touches the filesystem (no path escape)", () => {
		assert.equal(notesStore.readNotes("../evil"), null, "reads as no notes");
		const p1 = buildPage(draft({ concepts: [concept("A")] }), [], meta("m1"));
		assert.throws(() => notesStore.appendPage("../evil", p1), /Invalid chat id/);
		assert.equal(fs.existsSync(path.join(TMP_DATA, "evil.json")), false);
	});
});

describe("closing a session without notes", () => {
	const written = () => buildPage(draft({ concepts: [concept("A"), concept("B")] }), [], meta("m2"));

	it("a skipped page is an empty boundary: one page per session, no concepts, flagged", () => {
		const p1 = written();
		const skip = buildSkippedPage([p1], { createdAt: "2026-11-02T00:00:00.000Z", toMessageId: "m5" });
		assert.equal(skip.n, 2);
		assert.equal(skip.skipped, true);
		assert.equal(skip.toMessageId, "m5");
		assert.deepEqual(skip.concepts, []);
		assert.equal(skip.summary, "");
	});

	it("it does not move the concept numbering: the next written page continues from the last real concept", () => {
		const p1 = written();
		const skip = buildSkippedPage([p1], { createdAt: "2026-11-02T00:00:00.000Z", toMessageId: "m5" });
		const p3 = buildPage(draft({ concepts: [concept("C", [1])] }), [p1, skip], meta("m9"));
		assert.equal(p3.n, 3, "pages stay one per session");
		assert.equal(p3.concepts[0]!.n, 3, "concepts continue 1, 2, then 3");
		assert.equal(maxConceptNumber([p1, skip]), 2);
	});

	it("the next session starts after the skipped page's boundary", () => {
		const msgs = [msg("user", "m1"), msg("assistant", "m2"), msg("user", "m3"), msg("assistant", "m4")];
		const skip = buildSkippedPage([], { createdAt: "2026-11-02T00:00:00.000Z", toMessageId: "m2" });
		const slice = openSessionSlice(msgs, [skip])!;
		assert.deepEqual(slice.messages.map((m) => (m as { id: string }).id), ["m3", "m4"]);
		assert.match(pageBoundaryProblem(msgs, [skip], "m2")!, /out of date/, "the same boundary cannot be closed twice");
	});

	it("newestWrittenPage looks past skipped sessions", () => {
		const p1 = written();
		const skip = buildSkippedPage([p1], { createdAt: "2026-11-02T00:00:00.000Z", toMessageId: "m5" });
		assert.equal(newestWrittenPage([p1, skip]), p1);
		assert.equal(newestWrittenPage([skip]), undefined);
		assert.equal(newestWrittenPage([]), undefined);
	});

	it("renders as one honest line, and the document keeps its place", () => {
		const p1 = written();
		const skip = buildSkippedPage([p1], { createdAt: "2026-11-02T00:00:00.000Z", toMessageId: "m5" });
		const md = renderNotesMarkdown({ ...emptyNotes("c"), pages: [p1, skip] }, "Calc");
		assert.ok(md.includes("## Page 2 — 2026-11-02\n\n_Session closed without notes._"));
		assert.ok(md.indexOf("## Page 1") < md.indexOf("## Page 2"));
	});

	it("the store appends it like any page, in order", () => {
		const p1 = written();
		notesStore.appendPage("chat_skip", p1);
		const skip = buildSkippedPage([p1], { createdAt: "2026-11-02T00:00:00.000Z", toMessageId: "m5" });
		const rec = notesStore.appendPage("chat_skip", skip);
		assert.equal(rec.pages.length, 2);
		assert.equal(rec.pages[1]!.skipped, true);
		assert.throws(() => notesStore.appendPage("chat_skip", skip), /not the next page/);
	});
});

describe("previewPage (the read-only review)", () => {
	it("shows the draft numbered exactly as it will be saved", () => {
		const p1 = buildPage(draft({ concepts: [concept("A"), concept("B")] }), [], meta("m1"));
		const d = draft({ concepts: [concept("C", [1]), concept("D")], rules: ["r"] });
		const preview = previewPage(d, 2, maxConceptNumber([p1]) + 1, "2026-11-03T00:00:00.000Z");
		const saved = buildPage(d, [p1], meta("m9"));
		assert.deepEqual(preview.concepts, saved.concepts, "same numbers and refs as the saved page");
		assert.equal(preview.n, saved.n);
		assert.deepEqual(preview.rules, saved.rules);
	});
});
