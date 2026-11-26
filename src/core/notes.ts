/**
 * Session NOTES — the pure half of Close session.
 *
 * One chat is one material, and it keeps ONE notes document that only ever
 * GROWS: each Close session appends a new page covering what that session
 * added. Earlier pages are never rewritten (the learner may have copied them
 * to paper) — a mistake in an old page is fixed by a Correction item on the
 * NEW page. Continuity is guaranteed by CODE, not by prompting:
 *
 *   - the model submits an UNNUMBERED draft (structured sections); this module
 *     numbers the concepts, continuing from the last page, so "Concept 3"
 *     keeps meaning the same thing forever and a page can point back at it;
 *   - references to earlier concepts are validated against what exists;
 *   - every page is rendered from the same template, in the same section
 *     order, so page 2 reads as page 1's continuation.
 *
 * The session boundary lives HERE, not on the chat record: the open session is
 * "every message after the last page's `toMessageId`". Closing is explicit;
 * starting is implicit (the first message after a Close opens the next one).
 *
 * Pure core: browser-safe, no IO, no model. The model call lives in
 * src/server/notes.ts; persistence in src/store/notes.ts.
 */

import type { PlanTree } from "./contracts/plan.ts";
import type { LhMessage } from "./native-messages.ts";

export const NOTES_FORMAT_VERSION = 1;

// ─── shapes ──────────────────────────────────────────────────────────────────

export interface NoteConcept {
	/** Global, stable, 1-based across the whole document. */
	n: number;
	title: string;
	body: string;
	/** Earlier concept numbers this one builds on (always < n). */
	refs: number[];
}

export interface NoteMisconception {
	believed: string;
	whyWrong: string;
	correct: string;
}

export interface NoteCorrection {
	/** The earlier concept this fixes. */
	corrects: number;
	text: string;
}

/** What the model submits and the learner may edit before saving: the same
 *  sections as a page, minus everything the code assigns (numbers, ids,
 *  timestamps). */
export interface NotesDraft {
	summary: string;
	concepts: { title: string; body: string; refs: number[] }[];
	rules: string[];
	examples: string[];
	stuck: string[];
	misconceptions: NoteMisconception[];
	corrections: NoteCorrection[];
	open: string[];
}

export interface NotePage {
	/** 1-based page number. */
	n: number;
	createdAt: string;
	/** The last message this page covers — the next session starts after it. */
	toMessageId: string;
	/** "ai" until the learner edits the draft before saving. */
	origin: "ai" | "edited";
	summary: string;
	concepts: NoteConcept[];
	rules: string[];
	examples: string[];
	stuck: string[];
	misconceptions: NoteMisconception[];
	corrections: NoteCorrection[];
	open: string[];
	/** A legacy field from when the page had an in-app own-words box. The UI no
	 *  longer offers it (the learner writes their notes on paper); old pages that
	 *  carry text keep showing it. */
	own: string;
	/** The session was CLOSED WITHOUT NOTES: a boundary page with no content, so
	 *  the next session still starts after it. */
	skipped?: true;
}

export interface NotesRecord {
	version: typeof NOTES_FORMAT_VERSION;
	chatId: string;
	pages: NotePage[];
}

export function emptyNotes(chatId: string): NotesRecord {
	return { version: NOTES_FORMAT_VERSION, chatId, pages: [] };
}

export function emptyDraft(): NotesDraft {
	return { summary: "", concepts: [], rules: [], examples: [], stuck: [], misconceptions: [], corrections: [], open: [] };
}

// ─── numbering + draft hygiene ───────────────────────────────────────────────

/** The highest concept number in the document so far (0 when empty). */
export function maxConceptNumber(pages: readonly NotePage[]): number {
	let max = 0;
	for (const page of pages) for (const c of page.concepts) if (c.n > max) max = c.n;
	return max;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s) => s !== "") : []);
const intList = (v: unknown): number[] => {
	if (!Array.isArray(v)) return [];
	const out: number[] = [];
	for (const x of v) if (typeof x === "number" && Number.isInteger(x) && x > 0 && !out.includes(x)) out.push(x);
	return out;
};

/** Coerce anything (a weak model's submit, a learner's edited JSON) into a
 *  well-formed draft: trimmed strings, incomplete entries dropped. Never
 *  throws — validation is a separate, explicit step. */
export function normalizeDraft(raw: unknown): NotesDraft {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
	return {
		summary: str(r.summary),
		concepts: list(r.concepts)
			.map((c) => {
				const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
				return { title: str(o.title), body: str(o.body), refs: intList(o.refs) };
			})
			.filter((c) => c.title !== "" && c.body !== ""),
		rules: strList(r.rules),
		examples: strList(r.examples),
		stuck: strList(r.stuck),
		misconceptions: list(r.misconceptions)
			.map((m) => {
				const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
				return { believed: str(o.believed), whyWrong: str(o.whyWrong), correct: str(o.correct) };
			})
			.filter((m) => m.believed !== "" && m.correct !== ""),
		corrections: list(r.corrections)
			.map((c) => {
				const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
				return { corrects: typeof o.corrects === "number" && Number.isInteger(o.corrects) ? o.corrects : 0, text: str(o.text) };
			})
			.filter((c) => c.corrects > 0 && c.text !== ""),
		open: strList(r.open),
	};
}

export function draftHasContent(d: NotesDraft): boolean {
	return (
		d.summary !== "" ||
		d.concepts.length > 0 ||
		d.rules.length > 0 ||
		d.examples.length > 0 ||
		d.stuck.length > 0 ||
		d.misconceptions.length > 0 ||
		d.corrections.length > 0 ||
		d.open.length > 0
	);
}

/** Pipeline-law check of a draft against the document so far. Returns a
 *  problem string (the submit seam feeds it back to the model to retry) or
 *  null. References may only point at EARLIER pages' concepts. */
export function validateDraft(draft: NotesDraft, pages: readonly NotePage[]): string | null {
	if (!draftHasContent(draft)) return "The page is empty — write what this session added.";
	const max = maxConceptNumber(pages);
	for (const c of draft.concepts) {
		for (const ref of c.refs) {
			if (ref < 1 || ref > max) return `Concept "${c.title}" refs ${ref}, but earlier concepts only go up to ${max}. Reference only concepts from earlier pages (or leave refs empty).`;
		}
	}
	for (const corr of draft.corrections) {
		if (corr.corrects < 1 || corr.corrects > max) return `A correction targets concept ${corr.corrects}, but earlier concepts only go up to ${max}.`;
	}
	return null;
}

/** Turn a validated draft into the next page: concepts are numbered from
 *  (highest existing + 1). Throws on an invalid draft — callers validate. */
export function buildPage(
	draft: NotesDraft,
	pages: readonly NotePage[],
	meta: { createdAt: string; toMessageId: string; origin: "ai" | "edited"; own?: string },
): NotePage {
	const problem = validateDraft(draft, pages);
	if (problem) throw new Error(problem);
	let next = maxConceptNumber(pages) + 1;
	return {
		n: pages.length + 1,
		createdAt: meta.createdAt,
		toMessageId: meta.toMessageId,
		origin: meta.origin,
		summary: draft.summary,
		concepts: draft.concepts.map((c) => ({ n: next++, title: c.title, body: c.body, refs: c.refs })),
		rules: draft.rules,
		examples: draft.examples,
		stuck: draft.stuck,
		misconceptions: draft.misconceptions,
		corrections: draft.corrections,
		open: draft.open,
		own: str(meta.own),
	};
}

/** The boundary page for "Close session without notes": no content, and the
 *  next session starts after it. Page numbers stay one-per-session; concept
 *  numbering is untouched (it has no concepts). */
export function buildSkippedPage(pages: readonly NotePage[], meta: { createdAt: string; toMessageId: string }): NotePage {
	return {
		n: pages.length + 1,
		createdAt: meta.createdAt,
		toMessageId: meta.toMessageId,
		origin: "ai",
		summary: "",
		concepts: [],
		rules: [],
		examples: [],
		stuck: [],
		misconceptions: [],
		corrections: [],
		open: [],
		own: "",
		skipped: true,
	};
}

/** The newest page that actually has notes (skipping sessions closed without
 *  them) — what "the last session's notes" means to the warm-up. */
export function newestWrittenPage(pages: readonly NotePage[]): NotePage | undefined {
	for (let i = pages.length - 1; i >= 0; i--) if (!pages[i]!.skipped) return pages[i];
	return undefined;
}

/** A draft shown as the page it WOULD become (numbers assigned exactly as
 *  buildPage will), for the read-only review before saving. Pure; never throws. */
export function previewPage(draft: NotesDraft, pageNumber: number, nextConcept: number, createdAt: string): NotePage {
	return {
		n: pageNumber,
		createdAt,
		toMessageId: "",
		origin: "ai",
		summary: draft.summary,
		concepts: draft.concepts.map((c, i) => ({ n: nextConcept + i, title: c.title, body: c.body, refs: c.refs })),
		rules: draft.rules,
		examples: draft.examples,
		stuck: draft.stuck,
		misconceptions: draft.misconceptions,
		corrections: draft.corrections,
		open: draft.open,
		own: "",
	};
}

// ─── the open session ────────────────────────────────────────────────────────

/** The messages the NEXT page would cover: everything after the last page's
 *  `toMessageId` (all of them when there is no page yet). Null when the last
 *  boundary id is no longer in the transcript (the caller refuses rather than
 *  guess). */
export function openSessionSlice(
	messages: readonly LhMessage[],
	pages: readonly NotePage[],
): { messages: readonly LhMessage[]; fromIndex: number } | null {
	const last = pages[pages.length - 1];
	if (!last) return { messages, fromIndex: 0 };
	const at = messages.findIndex((m) => (m as { id?: string }).id === last.toMessageId);
	if (at < 0) return null;
	return { messages: messages.slice(at + 1), fromIndex: at + 1 };
}

/** Did the learner actually say or answer anything in this slice? A slice with
 *  only teacher output (or nothing) has nothing worth a page. */
export function sliceHasLearnerActivity(slice: readonly LhMessage[]): boolean {
	return slice.some((m) => {
		const role = (m as { role?: string }).role;
		return role === "user" || role === "toolResult";
	});
}

/** May a page ending at `toMessageId` be saved now? It must name a message that
 *  exists, at or after where the open session begins, with learner activity in
 *  between — i.e. exactly the slice a fresh draft would have covered (a stale
 *  tab saving an old draft is refused). Returns a problem string or null. */
export function pageBoundaryProblem(
	messages: readonly LhMessage[],
	pages: readonly NotePage[],
	toMessageId: string,
): string | null {
	const slice = openSessionSlice(messages, pages);
	if (!slice) return "The last page's boundary is no longer in this chat.";
	const end = messages.findIndex((m) => (m as { id?: string }).id === toMessageId);
	if (end < slice.fromIndex) return "That draft is out of date — this session has already been closed. Reopen Close session.";
	if (!sliceHasLearnerActivity(messages.slice(slice.fromIndex, end + 1))) return "Nothing new to write down yet.";
	return null;
}

export function lastMessageId(messages: readonly LhMessage[]): string | null {
	const id = (messages[messages.length - 1] as { id?: string } | undefined)?.id;
	return typeof id === "string" && id !== "" ? id : null;
}

// ─── struggle signals (what the quiz answers say about the learner) ──────────

export type StruggleKind = "committed-misconception" | "dont-know" | "wrong" | "fragile";

export interface StruggleSignal {
	kind: StruggleKind;
	question: string;
	/** The plan node's title when the call was tagged with a known nodeId. */
	node?: string;
	confidence?: number;
}

const SEVERITY: Record<StruggleKind, number> = { "committed-misconception": 0, "dont-know": 1, wrong: 2, fragile: 3 };
const HIGH_CONFIDENCE = 70;
const LOW_CONFIDENCE = 40;
const MAX_SIGNALS = 20;

/** The confidence doctrine's reading of ONE quiz result's details: a
 *  confidently wrong answer = a committed misconception; "I don't know" = a
 *  genuine gap; wrong = wrong; right-but-unsure = fragile; anything else (a
 *  confident right answer, a dismissed check) = no signal. Shared with the
 *  warm-up's selection (core/warmup.ts). */
export function struggleKindOf(d: Record<string, unknown> | undefined): StruggleKind | null {
	if (!d || d.dismissed === true) return null;
	const confidence = typeof d.confidence === "number" ? d.confidence : undefined;
	if (d.dontKnow === true) return "dont-know";
	if (d.correct === false) return confidence !== undefined && confidence >= HIGH_CONFIDENCE ? "committed-misconception" : "wrong";
	if (d.correct === true && confidence !== undefined && confidence <= LOW_CONFIDENCE) return "fragile";
	return null;
}

/** Fold quiz outcomes into the signals the confidence doctrine names (a
 *  confidently wrong answer = a committed misconception; "I don't know" = a
 *  genuine gap; right-but-unsure = fragile). Pure: reads the transcript only;
 *  ranked worst-first and capped. */
export function struggleSignals(messages: readonly LhMessage[], tree?: PlanTree | null): StruggleSignal[] {
	const nodeOfCall = new Map<string, string>();
	const titles = new Map((tree?.nodes ?? []).map((n) => [n.id, n.title]));
	for (const m of messages) {
		const msg = m as { role?: string; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content as Array<{ type?: string; id?: string; arguments?: { nodeId?: unknown } }>) {
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			const nodeId = block.arguments?.nodeId;
			if (typeof nodeId === "string" && titles.has(nodeId)) nodeOfCall.set(block.id, titles.get(nodeId)!);
		}
	}
	const out: StruggleSignal[] = [];
	for (const m of messages) {
		const msg = m as { role?: string; toolName?: string; toolCallId?: string; details?: Record<string, unknown> };
		if (msg.role !== "toolResult" || msg.toolName !== "quiz") continue;
		const d = msg.details;
		if (!d || d.dismissed === true) continue;
		const question = typeof d.questionText === "string" ? d.questionText.trim() : "";
		if (!question) continue;
		const confidence = typeof d.confidence === "number" ? d.confidence : undefined;
		const kind = struggleKindOf(d);
		if (!kind) continue;
		const node = msg.toolCallId ? nodeOfCall.get(msg.toolCallId) : undefined;
		out.push({ kind, question, ...(node ? { node } : {}), ...(confidence !== undefined ? { confidence } : {}) });
	}
	return out.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind]).slice(0, MAX_SIGNALS);
}

const SIGNAL_LABEL: Record<StruggleKind, string> = {
	"committed-misconception": "confidently WRONG (a committed misconception)",
	"dont-know": "said I don't know (a real gap)",
	wrong: "answered wrong",
	fragile: "right but unsure (fragile)",
};

// ─── rendering ───────────────────────────────────────────────────────────────

/** Section headings — one map, so the language of the chrome is one edit. */
export const NOTE_HEADINGS = {
	learned: "Learned",
	rules: "Rules & formulas",
	examples: "Worked examples",
	stuck: "Where I got stuck",
	misconceptions: "Misconceptions",
	corrections: "Corrections",
	open: "Open questions",
	own: "In my own words",
} as const;

const bullets = (items: readonly string[]): string[] => items.map((s) => `- ${s}`);

export function renderPageMarkdown(page: NotePage): string {
	if (page.skipped) return `## Page ${page.n} — ${page.createdAt.slice(0, 10)}\n\n_Session closed without notes._`;
	const out: string[] = [`## Page ${page.n} — ${page.createdAt.slice(0, 10)}`];
	if (page.summary) out.push("", page.summary);
	const section = (heading: string, lines: readonly string[]) => {
		if (lines.length > 0) out.push("", `### ${heading}`, "", ...lines);
	};
	section(
		NOTE_HEADINGS.learned,
		page.concepts.map((c) => `**${c.n}. ${c.title}** — ${c.body}${c.refs.length > 0 ? ` *(builds on ${c.refs.map((r) => `${r}`).join(", ")})*` : ""}`),
	);
	section(NOTE_HEADINGS.rules, bullets(page.rules));
	section(NOTE_HEADINGS.examples, bullets(page.examples));
	section(NOTE_HEADINGS.stuck, bullets(page.stuck));
	section(
		NOTE_HEADINGS.misconceptions,
		page.misconceptions.map((m) => `- I believed: ${m.believed}${m.whyWrong ? ` — why it is wrong: ${m.whyWrong}` : ""} — correct: ${m.correct}`),
	);
	section(NOTE_HEADINGS.corrections, page.corrections.map((c) => `- Concept ${c.corrects}: ${c.text}`));
	section(NOTE_HEADINGS.open, bullets(page.open));
	if (page.own) out.push("", `### ${NOTE_HEADINGS.own}`, "", page.own);
	return out.join("\n");
}

export function renderNotesMarkdown(record: NotesRecord, title: string): string {
	const head = [`# ${title} — notes`];
	if (record.pages.length === 0) return `${head[0]}\n\n_No pages yet._\n`;
	return `${head[0]}\n\n${record.pages.map(renderPageMarkdown).join("\n\n")}\n`;
}

// ─── the generator's prompt ──────────────────────────────────────────────────

/** Keep the START and END of an over-long text, eliding the middle with a
 *  visible marker (a session's opening frames the goal; its end is where it
 *  stopped). */
export function elideMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.35);
	const tail = max - head;
	return `${text.slice(0, head)}\n\n[… ${text.length - max} characters of the middle of this session omitted …]\n\n${text.slice(text.length - tail)}`;
}

/** The earlier pages as the generator sees them. Within the budget: every
 *  page in full. Over it: older pages shrink to their concept titles, the
 *  newest page stays full — numbering and terms must always be visible. */
export function previousNotesDigest(pages: readonly NotePage[], maxChars = 14_000): string {
	if (pages.length === 0) return "(none — this is the first page)";
	const full = (p: NotePage) => renderPageMarkdown(p);
	const compact = (p: NotePage) =>
		`## Page ${p.n} (titles only)\n${p.concepts.map((c) => `${c.n}. ${c.title}`).join("\n") || "(no new concepts)"}`;
	const all = pages.map(full).join("\n\n");
	if (all.length <= maxChars) return all;
	const newest = full(pages[pages.length - 1]!);
	const older = pages.slice(0, -1).map(compact).join("\n\n");
	return elideMiddle(`${older}\n\n${newest}`, maxChars);
}

/** The whole user prompt for one page. */
export function notesPrompt(input: {
	title: string;
	tree: PlanTree | null | undefined;
	pages: readonly NotePage[];
	signals: readonly StruggleSignal[];
	transcript: string;
	maxTranscriptChars?: number;
}): string {
	const plan =
		input.tree && input.tree.nodes.length > 0
			? input.tree.nodes.map((n) => `- ${n.title}${n.summary ? `: ${n.summary}` : ""}`).join("\n")
			: "(no plan yet)";
	const signals =
		input.signals.length > 0
			? input.signals
					.map((s) => `- ${SIGNAL_LABEL[s.kind]}${s.confidence !== undefined ? ` (${s.confidence}% sure)` : ""}${s.node ? ` [${s.node}]` : ""}: ${s.question}`)
					.join("\n")
			: "(none recorded)";
	return [
		`Session title: ${input.title}`,
		"",
		"# Plan",
		plan,
		"",
		"# Earlier pages of these notes (do NOT rewrite them; continue from them)",
		previousNotesDigest(input.pages),
		`Highest concept number so far: ${maxConceptNumber(input.pages)}`,
		"",
		"# How the learner did on checks this session (ground your Stuck / Misconceptions sections in this)",
		signals,
		"",
		"# This session's transcript",
		elideMiddle(input.transcript, input.maxTranscriptChars ?? 60_000),
	].join("\n");
}
