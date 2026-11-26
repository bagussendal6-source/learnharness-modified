/**
 * The FINAL EXAM — completion, grading, and the status line. Pure core.
 *
 * "Done" is defined in three steps (owner, 2026-11-06):
 *   1. the whole plan has been COVERED (every plan node was reached by a
 *      tagged check — position, not results);
 *   2. the learner takes the final exam (a separate exam session);
 *   3. the exam score reaches the PASS grade (B or better, >= 80%).
 * Below the pass grade the plan is clear but the chat is NOT done: the learner
 * retakes. The best FINISHED attempt counts, so a later worse attempt never
 * takes a pass away.
 *
 * Nothing here is stored. Coverage derives from the transcript + plan; an
 * attempt's result derives from the exam session's own transcript; the
 * chat's completion is a fold over its exam sessions — the app's
 * derive-on-read ethos (no completion ledger, no ability score in the graph).
 *
 * Scoring is deterministic: each problem's `conclude` outcome maps to points
 * (solved 1, solvedWithHints 0.5, anything else 0) and the score is over the
 * exam's FIXED problem count, so an unfinished exam never reads as a pass.
 */

import type { PlanTree } from "./contracts/plan.ts";
import { derivePlanStatusesLh } from "./contracts/plan.ts";
import {
	newGraphContextMessage,
	PRACTICE_CONCLUDE_TOOL,
	problemInputForConclude,
	type GraphContextPick,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";

/** How many problems one exam has (tunable in one place). */
export const EXAM_PROBLEM_COUNT = 8;

/** The pass mark: B or better. */
export const PASS_PERCENT = 80;

export type Grade = "A" | "B" | "C" | "D" | "E";

/** A >= 90, B >= 80, C >= 70, D >= 60, else E. */
export function gradeOf(percent: number): Grade {
	if (percent >= 90) return "A";
	if (percent >= 80) return "B";
	if (percent >= 70) return "C";
	if (percent >= 60) return "D";
	return "E";
}

export function percentPasses(percent: number): boolean {
	return percent >= PASS_PERCENT;
}

/** Marks a practice-kind session as a final exam of `parentChatId`. */
export interface ExamMeta {
	parentChatId: string;
	/** The fixed problem count this exam was created with. */
	total: number;
}

/** At most `max` items, spread evenly across the list (first item always
 *  kept) — the exam's material cap must not cut off the END of the plan. */
export function sampleEvenly<T>(items: readonly T[], max: number): T[] {
	if (items.length <= max) return [...items];
	const step = items.length / max;
	return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]!);
}

// ─── step 1: coverage ────────────────────────────────────────────────────────

export interface PlanCoverage {
	/** Nodes in the current plan. */
	total: number;
	/** Plan nodes reached by at least one tagged check (visited or current). */
	covered: number;
	/** The plan has nodes and every one was reached. */
	complete: boolean;
}

/** How much of the plan the transcript has reached. A node counts once any
 *  tagged check referenced it — the CURRENT node counts too (it is always the
 *  last one reached, so "visited" alone could never be complete). A rewritten
 *  plan is judged against its CURRENT nodes. */
export function planCoverage(tree: PlanTree | null | undefined, messages: readonly LhMessage[]): PlanCoverage {
	const total = tree?.nodes.length ?? 0;
	if (!tree || total === 0) return { total: 0, covered: 0, complete: false };
	const statuses = derivePlanStatusesLh(tree, messages);
	let covered = 0;
	for (const node of tree.nodes) {
		if (statuses.visited.has(node.id) || statuses.current === node.id) covered++;
	}
	return { total, covered, complete: covered === total };
}

// ─── step 2: scoring one exam attempt ────────────────────────────────────────

const OUTCOME_POINTS: Record<string, number> = { solved: 1, solvedWithHints: 0.5 };

export interface PropositionResult {
	id: string;
	points: number;
	of: number;
}

export interface ExamResult {
	total: number;
	/** Problems concluded so far (capped at `total`). */
	concluded: number;
	/** Every problem of the exam has been concluded. */
	finished: boolean;
	points: number;
	/** 0..100 over the FIXED total. */
	percent: number;
	grade: Grade;
	/** Finished AND at/above the pass mark. */
	passed: boolean;
	/** Per tagged proposition: points earned of problems that exercised it. */
	perProposition: PropositionResult[];
}

/** Score an exam session's transcript. Only CLEAN conclude calls count (a
 *  refused conclude never happened); a dismissed problem counts as concluded
 *  with 0 points; problems beyond `total` are ignored. */
export function scoreExam(messages: readonly LhMessage[], total: number): ExamResult {
	const clean = new Set<string>();
	for (const m of messages) {
		const r = m as { role?: string; toolCallId?: string; isError?: boolean };
		if (r.role === "toolResult" && !r.isError && typeof r.toolCallId === "string") clean.add(r.toolCallId);
	}
	const per = new Map<string, PropositionResult>();
	let concluded = 0;
	let points = 0;
	for (const m of messages) {
		const msg = m as { role?: string; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content as Array<{ type?: string; id?: string; name?: string; arguments?: { outcome?: unknown } }>) {
			if (block?.type !== "toolCall" || block.name !== PRACTICE_CONCLUDE_TOOL || typeof block.id !== "string") continue;
			if (!clean.has(block.id) || concluded >= total) continue;
			concluded++;
			const outcome = typeof block.arguments?.outcome === "string" ? block.arguments.outcome : "";
			const earned = OUTCOME_POINTS[outcome] ?? 0;
			points += earned;
			const target = problemInputForConclude(messages, block.id)?.target;
			if (Array.isArray(target)) {
				for (const id of target) {
					if (typeof id !== "string") continue;
					const row = per.get(id) ?? { id, points: 0, of: 0 };
					row.points += earned;
					row.of += 1;
					per.set(id, row);
				}
			}
		}
	}
	const percent = total > 0 ? Math.round((points / total) * 100) : 0;
	const finished = total > 0 && concluded >= total;
	return {
		total,
		concluded,
		finished,
		points,
		percent,
		grade: gradeOf(percent),
		passed: finished && percentPasses(percent),
		perProposition: [...per.values()],
	};
}

// ─── step 3: the chat's completion (a fold over its exam attempts) ───────────

export interface ExamAttempt {
	examChatId: string;
	/** When the attempt's session was created (ISO). */
	at: string;
	result: ExamResult;
}

export type CompletionStatus =
	/** The plan is not fully covered yet — no marker. */
	| "not-covered"
	/** Plan covered, no finished exam yet — offer the exam. */
	| "ready"
	/** Plan covered, exam taken, below the pass mark — retest needed. */
	| "not-passed"
	/** Plan covered and a finished exam reached the pass mark. */
	| "completed";

export interface Completion {
	status: CompletionStatus;
	coverage: PlanCoverage;
	/** The best FINISHED attempt (highest percent; the earliest wins a tie), if any. */
	best: ExamAttempt | null;
	attempts: ExamAttempt[];
}

export function completionOf(coverage: PlanCoverage, attempts: readonly ExamAttempt[]): Completion {
	let best: ExamAttempt | null = null;
	for (const a of attempts) {
		if (!a.result.finished) continue;
		if (!best || a.result.percent > best.result.percent) best = a;
	}
	let status: CompletionStatus;
	if (!coverage.complete) status = "not-covered";
	else if (!best) status = "ready";
	else if (best.result.passed) status = "completed";
	else status = "not-passed";
	return { status, coverage, best, attempts: [...attempts] };
}

/** The one-line status the chat shows. Null when there is nothing to say yet. */
export function completionLine(c: Completion): string | null {
	switch (c.status) {
		case "not-covered":
			return null;
		case "ready":
			return "All plan clear — take the final exam.";
		case "not-passed":
			return `All plan clear · Exam not passed (best ${c.best!.result.grade}, ${c.best!.result.percent}%) — need retest!`;
		case "completed":
			return `Completed · ${c.best!.result.grade} (${c.best!.result.percent}%)`;
	}
}

// ─── the exam session's opening context ──────────────────────────────────────

/** The exam's context marker: the standard graph-context marker (so the
 *  transcript card and target validation work unchanged) with the exam's
 *  terms prepended for the model. */
export function examContextMessage(
	meta: ExamMeta,
	parentTitle: string,
	picks: readonly GraphContextPick[],
	chains: readonly string[],
): LhMarkerMessage {
	const base = newGraphContextMessage(picks, chains);
	const header = [
		"[Exam] — this session is the FINAL EXAM for the study session",
		`"${parentTitle}".`,
		`It has exactly ${meta.total} problems. Pass mark: ${PASS_PERCENT}% (grade B or better). No hints.`,
		"",
	].join("\n");
	return { ...base, content: `${header}\n${base.content as string}` } as LhMarkerMessage;
}
