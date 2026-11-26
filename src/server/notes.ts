import { Type } from "typebox";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import {
	buildPage,
	buildSkippedPage,
	emptyNotes,
	lastMessageId,
	normalizeDraft,
	notesPrompt,
	openSessionSlice,
	pageBoundaryProblem,
	sliceHasLearnerActivity,
	struggleSignals,
	validateDraft,
	type NotePage,
	type NotesDraft,
	type NotesRecord,
} from "../core/notes.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { emit } from "../core/events.ts";
import { isSessionClosed, newSessionClosedMessage, newSessionStartedMessage } from "../core/native-messages.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { kickSessionCompaction } from "./session-compaction.ts";

/**
 * CLOSE SESSION → one new page of notes.
 *
 * draftNotesPage(): reads the open session (everything after the last page's
 * boundary) plus the earlier pages, asks the STRONG-tier model for an
 * UNNUMBERED structured draft, and returns it — nothing is saved. The learner
 * reviews/edits it, then savePage() validates it again against the document
 * as it is NOW, numbers the concepts, and appends. Earlier pages are never
 * touched (core/notes.ts: append-only; continuity is code, not prompt).
 *
 * Does not touch the teacher/prober/practice prompts or the graph.
 */

const INSTRUCTIONS = `You write ONE new page of a learner's personal study notes.
The notes are a single document that only grows: each study session adds a page. The learner may copy the notes to paper, so
earlier pages are never rewritten — you continue from them.

You are given the plan, the earlier pages (with their numbered concepts), how the learner did on checks, and this session's transcript.
Call submit_notes with ONLY what this session ADDED.

Continuity rules (strict):
- Reuse the exact terms, symbols and notation the earlier pages use. Do not rename things.
- Do not re-explain a concept an earlier page already covers. If this session builds on it, put its number in "refs" and keep the new concept short.
- "refs" may only contain concept numbers that already exist (listed in the earlier pages). Do not number new concepts yourself; numbering is automatic.
- If an earlier page said something that this session shows was wrong or incomplete, add a "corrections" item (corrects = that concept's number). NEVER restate or edit the old text.
- If this session adds nothing to a section, leave it empty. Never pad.

Content rules:
- Write for the learner, in the language the learner uses in the transcript, as short self-contained statements that make sense on paper without the chat.
- concepts: the ideas established this session — a short title and 1-3 sentences each, stated as true propositions, with the WHY not just the what.
- rules: formulas / rules worth memorizing, exactly as established. examples: worked examples, compressed.
- stuck: where the learner got stuck or needed repair, and what unblocked it — ground this in the check results provided.
- misconceptions: what the learner believed (believed), why it is wrong (whyWrong), the correct statement (correct). Use the checks where the learner was confidently wrong first; invent none.
- open: questions the session raised but did not settle.
- summary: one or two sentences: what this session accomplished.`;

export type NotesFailure = { ok: false; status: 404 | 409 | 422 | 503; code: string; error: string };

export type NotesDraftResult =
	| { ok: true; draft: NotesDraft; toMessageId: string; pageNumber: number; nextConcept: number }
	| NotesFailure;

const draftSchema = Type.Object({
	summary: Type.String(),
	concepts: Type.Optional(
		Type.Array(Type.Object({ title: Type.String(), body: Type.String(), refs: Type.Optional(Type.Array(Type.Integer())) })),
	),
	rules: Type.Optional(Type.Array(Type.String())),
	examples: Type.Optional(Type.Array(Type.String())),
	stuck: Type.Optional(Type.Array(Type.String())),
	misconceptions: Type.Optional(Type.Array(Type.Object({ believed: Type.String(), whyWrong: Type.String(), correct: Type.String() }))),
	corrections: Type.Optional(Type.Array(Type.Object({ corrects: Type.Integer(), text: Type.String() }))),
	open: Type.Optional(Type.Array(Type.String())),
});

/** Draft the next page for `chatId` (saves nothing). */
export async function draftNotesPage(chatId: string, signal?: AbortSignal): Promise<NotesDraftResult> {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, code: "not_found", error: "Not found" };
	if (isTurnRunning(chatId)) {
		return { ok: false, status: 409, code: "turn_in_flight", error: "The teacher is still replying — close the session once the turn settles." };
	}
	const notes = stores.notesStore.readNotes(chatId) ?? emptyNotes(chatId);
	const slice = openSessionSlice(chat.messages, notes.pages);
	if (!slice) return { ok: false, status: 409, code: "boundary_lost", error: "The last page's boundary is no longer in this chat." };
	if (!sliceHasLearnerActivity(slice.messages)) {
		return { ok: false, status: 409, code: "nothing_new", error: "Nothing new to write down since the last page." };
	}
	const toMessageId = lastMessageId(chat.messages);
	if (!toMessageId) return { ok: false, status: 409, code: "nothing_new", error: "Nothing new to write down yet." };

	const spec = resolveConversationSpec(chat.settings, effectiveSettings().models.strong);
	if (!spec) return { ok: false, status: 503, code: "models_not_configured", error: "No strong model configured — set up your models first" };

	const prompt = notesPrompt({
		title: chat.title,
		tree: chat.tree,
		pages: notes.pages,
		signals: struggleSignals(slice.messages, chat.tree),
		transcript: sessionMarkdown(slice.messages, { anchors: false }),
	});
	try {
		const draft = await runSubmitAgent<NotesDraft>({
			role: "teacher",
			toolName: "submit_notes",
			toolDescription: "Submit the new page of notes for this session.",
			parameters: draftSchema,
			fill: (input) => normalizeDraft(input),
			// The pipeline laws (refs/corrections must point at real earlier
			// concepts; the page must not be empty) bounce back to the model.
			validate: (value) => validateDraft(value, notes.pages),
			systemPrompt: INSTRUCTIONS,
			prompt,
			engine: piEngineForSpec(spec, false),
			signal,
			onStep: () => {},
			neverSubmitted: "The model never submitted the notes page.",
			chatId,
		});
		const nextConcept = notes.pages.reduce((m, p) => p.concepts.reduce((mm, c) => Math.max(mm, c.n), m), 0) + 1;
		return { ok: true, draft, toMessageId, pageNumber: notes.pages.length + 1, nextConcept };
	} catch (error) {
		return { ok: false, status: 503, code: "draft_failed", error: error instanceof Error ? error.message : "Writing the notes page failed." };
	}
}

/** Leave the CLOSED marker at the end of the chat (a compact label in the
 *  transcript; the Start panel keys on it) and tell open views to refetch. */
function markClosed(chatId: string, pageNumber: number, notes: boolean): void {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return;
	stores.chatStore.saveMessages(chatId, [...chat.messages, newSessionClosedMessage({ pageNumber, notes })]);
	emit("record-changed", { chatId });
	// The next session starts light: fold the finished one(s) into the summary.
	kickSessionCompaction(chatId);
}

export type SavePageResult = { ok: true; record: NotesRecord; page: NotePage } | NotesFailure;

/** Validate and append a (possibly learner-edited) draft as the next page. */
export function savePage(
	chatId: string,
	input: { draft: unknown; toMessageId: unknown; own?: unknown; edited?: unknown },
): SavePageResult {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, code: "not_found", error: "Not found" };
	if (isTurnRunning(chatId)) {
		return { ok: false, status: 409, code: "turn_in_flight", error: "The teacher is still replying — close the session once the turn settles." };
	}
	if (typeof input.toMessageId !== "string" || input.toMessageId === "") {
		return { ok: false, status: 422, code: "bad_request", error: "toMessageId is required" };
	}
	const notes = stores.notesStore.readNotes(chatId) ?? emptyNotes(chatId);
	const boundary = pageBoundaryProblem(chat.messages, notes.pages, input.toMessageId);
	if (boundary) return { ok: false, status: 409, code: "stale_draft", error: boundary };
	const draft = normalizeDraft(input.draft);
	const problem = validateDraft(draft, notes.pages);
	if (problem) return { ok: false, status: 422, code: "invalid_draft", error: problem };
	const page = buildPage(draft, notes.pages, {
		createdAt: new Date().toISOString(),
		toMessageId: input.toMessageId,
		origin: input.edited === true ? "edited" : "ai",
		own: typeof input.own === "string" ? input.own : "",
	});
	const record = stores.notesStore.appendPage(chatId, page);
	markClosed(chatId, page.n, true);
	return { ok: true, record, page };
}

/** CLOSE SESSION WITHOUT NOTES: ends the open session with a boundary page that
 *  has no content — no model call, nothing to review. The next session starts
 *  after it, exactly as after a written page. */
export function closeWithoutNotes(chatId: string): SavePageResult {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, code: "not_found", error: "Not found" };
	if (isTurnRunning(chatId)) {
		return { ok: false, status: 409, code: "turn_in_flight", error: "The teacher is still replying — close the session once the turn settles." };
	}
	const notes = stores.notesStore.readNotes(chatId) ?? emptyNotes(chatId);
	const toMessageId = lastMessageId(chat.messages);
	if (!toMessageId) return { ok: false, status: 409, code: "nothing_new", error: "Nothing to close yet." };
	const boundary = pageBoundaryProblem(chat.messages, notes.pages, toMessageId);
	if (boundary) return { ok: false, status: 409, code: "nothing_new", error: boundary };
	const page = buildSkippedPage(notes.pages, { createdAt: new Date().toISOString(), toMessageId });
	const record = stores.notesStore.appendPage(chatId, page);
	markClosed(chatId, page.n, false);
	return { ok: true, record, page };
}

export type StartSessionResult = { ok: true } | NotesFailure;

/** START THE NEXT SESSION WITHOUT A WARM-UP: ends the closed state with a
 *  compact "started" label; the question that was waiting returns. (Starting
 *  with a warm-up, or just typing, ends it without this call.) */
export function startSessionWithoutWarmup(chatId: string): StartSessionResult {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, code: "not_found", error: "Not found" };
	if (isTurnRunning(chatId)) return { ok: false, status: 409, code: "turn_in_flight", error: "The teacher is still replying." };
	if (!isSessionClosed(chat.messages)) return { ok: true };
	stores.chatStore.saveMessages(chatId, [...chat.messages, newSessionStartedMessage()]);
	emit("record-changed", { chatId });
	return { ok: true };
}
