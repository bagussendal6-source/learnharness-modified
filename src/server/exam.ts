import { chainsForSelection, formatChainLine } from "../core/chains.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import {
	completionOf,
	EXAM_PROBLEM_COUNT,
	examContextMessage,
	planCoverage,
	sampleEvenly,
	scoreExam,
	type Completion,
	type ExamAttempt,
	type ExamMeta,
	type ExamResult,
} from "../core/exam.ts";
import type { GraphContextPick } from "../core/native-messages.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * The FINAL EXAM, server side (core/exam.ts holds every rule).
 *
 * An exam is an ordinary practice-kind session marked with ChatRecord.exam and
 * run by the examiner agent (prompts/exam/). The material is the knowledge-graph
 * propositions whose provenance is the parent session; the score and the chat's
 * completion are DERIVED on read from the exam sessions' own transcripts —
 * nothing about a grade is stored, and nothing is written to the graph.
 */

/** The most propositions one exam shows the examiner (the practice picks cap). */
const MAX_MATERIAL = 64;

export type ExamFailure = { ok: false; status: 404 | 409 | 503; code: string; error: string };

export type StartExamResult = { ok: true; id: string; prompt: string } | ExamFailure;

/** Create a final-exam session for `parentChatId`. Only a teaching session that
 *  has covered its whole plan can be examined. */
export function startExam(parentChatId: string): StartExamResult {
	const parent = stores.chatStore.getChat(parentChatId);
	if (!parent) return { ok: false, status: 404, code: "not_found", error: "Not found" };
	if (parent.kind === "practice") {
		return { ok: false, status: 409, code: "not_teaching", error: "Only a teaching session has a final exam." };
	}
	if (isTurnRunning(parentChatId)) {
		return { ok: false, status: 409, code: "turn_in_flight", error: "The teacher is still replying — start the exam once the turn settles." };
	}
	if (!planCoverage(parent.tree, parent.messages).complete) {
		return { ok: false, status: 409, code: "not_covered", error: "The whole plan has not been covered yet." };
	}
	const nodes = stores.graphStore.readNodes().filter((n) => n.provenance.some((p) => p.chatId === parentChatId));
	if (nodes.length === 0) {
		return {
			ok: false,
			status: 409,
			code: "no_material",
			error: "Nothing from this session is in your knowledge graph yet — extraction may still be running. Try again in a moment.",
		};
	}
	const material = sampleEvenly(nodes, MAX_MATERIAL);
	const picks: GraphContextPick[] = material.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
	const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
	const chainLines = chainsForSelection(material, stores.graphStore.readChains()).map((c) => formatChainLine(c, Object.fromEntries(byId)));

	const meta: ExamMeta = { parentChatId, total: EXAM_PROBLEM_COUNT };
	const chat = stores.chatStore.createChat(titleFromPrompt(`Final exam — ${parent.title}`), "practice");
	// A fixed, descriptive title: stamped "manual" so the AI namer never renames it.
	stores.chatStore.renameChat(chat.id, chat.title, "manual");
	// Per-session model (owner 2026-09-28): stamp from the STRONG slot, like every new session.
	const strong = stores.settingsStore.readSettings()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, { model: { provider: strong.model.provider, id: strong.model.id }, thinkingLevel: strong.thinkingLevel });
	}
	stores.chatStore.setExam(chat.id, meta);
	stores.chatStore.saveMessages(chat.id, [examContextMessage(meta, parent.title, picks, chainLines)]);
	return { ok: true, id: chat.id, prompt: "Begin the final exam." };
}

/** Every exam attempt of `chatId`, oldest first, each scored from its own transcript. */
export function examAttemptsOf(chatId: string): ExamAttempt[] {
	return stores.chatStore
		.listChats()
		.filter((c) => c.exam?.parentChatId === chatId)
		.map((c) => ({ summary: c, record: stores.chatStore.getChat(c.id) }))
		.filter((x): x is { summary: typeof x.summary; record: NonNullable<typeof x.record> } => x.record !== null && x.record.exam !== undefined)
		.map(({ summary, record }) => ({
			examChatId: summary.id,
			at: summary.createdAt,
			result: scoreExam(record.messages, record.exam!.total),
		}))
		.sort((a, b) => a.at.localeCompare(b.at));
}

export type CompletionResult = { ok: true; completion: Completion } | ExamFailure;

/** The chat's completion: plan coverage folded with its exam attempts. */
export function completionForChat(chatId: string): CompletionResult {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, code: "not_found", error: "Not found" };
	const coverage = planCoverage(chat.tree, chat.messages);
	return { ok: true, completion: completionOf(coverage, examAttemptsOf(chatId)) };
}

export interface ExamState {
	parentChatId: string;
	parentTitle: string;
	result: ExamResult;
	/** id → name for the propositions that appear in the breakdown. */
	propositions: Record<string, string>;
}

export type ExamStateResult = { ok: true; state: ExamState } | ExamFailure;

/** An exam session's current result (the exam panel's data). */
export function examStateOf(examChatId: string): ExamStateResult {
	const chat = stores.chatStore.getChat(examChatId);
	if (!chat || !chat.exam) return { ok: false, status: 404, code: "not_found", error: "Not an exam session" };
	const result = scoreExam(chat.messages, chat.exam.total);
	const names = new Map(stores.graphStore.readNodes().map((n) => [n.id, n.name]));
	const propositions: Record<string, string> = {};
	for (const p of result.perProposition) propositions[p.id] = names.get(p.id) ?? p.id;
	const parent = stores.chatStore.getChat(chat.exam.parentChatId);
	return { ok: true, state: { parentChatId: chat.exam.parentChatId, parentTitle: parent?.title ?? "(deleted session)", result, propositions } };
}
