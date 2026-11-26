/**
 * THE FOLDER OVERVIEW — one card per session, derived (never stored).
 *
 * Clicking a folder opens a page that answers, for each session in it, "what
 * is this, where am I, and what did I write down": its tags, the material (the
 * plan's own steps), progress through the plan, its completion state (all plan
 * clear / exam not passed / completed with the grade), and a line from the
 * latest notes. Everything here is a pure fold over data the app already keeps —
 * no model call, no extra storage.
 */

import { completionLine, completionOf, planCoverage, type Completion, type ExamAttempt } from "./exam.ts";
import type { PlanTree } from "./contracts/plan.ts";
import { isSessionClosed, type LhMessage } from "./native-messages.ts";
import { newestWrittenPage, type NotePage } from "./notes.ts";

/** How many plan steps a card lists before "+N more". */
export const CARD_MATERIAL_MAX = 6;

export interface SessionCard {
	id: string;
	title: string;
	kind: "teach" | "practice";
	updatedAt: string;
	tags: string[];
	/** The chat is closed right now (its Start panel is waiting). */
	closed: boolean;
	/** The plan's steps, in plan order; empty for sessions with no plan. */
	material: { titles: string[]; more: number };
	/** Steps reached out of the plan's total; null when there is no plan. */
	progress: { covered: number; total: number } | null;
	/** Teaching sessions only. `status` is the exam-aware state; `line` is the
	 *  same one-line text the chat's banner shows (null until the plan is clear). */
	completion: { status: Completion["status"]; line: string | null; best: { grade: string; percent: number; passed: boolean } | null } | null;
	notes: {
		/** Pages that actually hold notes (sessions closed without notes excluded). */
		written: number;
		/** Sessions closed so far, written or not. */
		sessions: number;
		/** One line from the newest written page, or null. */
		latest: string | null;
	};
}

export interface SessionCardInput {
	id: string;
	title: string;
	kind?: string;
	updatedAt: string;
	tags?: string[];
	tree?: PlanTree | null;
	messages: readonly LhMessage[];
	attempts: readonly ExamAttempt[];
	pages: readonly NotePage[];
}

/** One line from the newest written page: its summary, else its first concepts. */
export function latestNoteLine(pages: readonly NotePage[]): string | null {
	const page = newestWrittenPage(pages);
	if (!page) return null;
	if (page.summary) return page.summary;
	if (page.concepts.length > 0) return page.concepts.slice(0, 3).map((c) => c.title).join(" · ");
	return null;
}

export function buildSessionCard(input: SessionCardInput): SessionCard {
	const isPractice = input.kind === "practice";
	const nodes = input.tree?.nodes ?? [];
	const coverage = planCoverage(input.tree, input.messages);
	const completion = isPractice ? null : completionOf(coverage, input.attempts);
	return {
		id: input.id,
		title: input.title,
		kind: isPractice ? "practice" : "teach",
		updatedAt: input.updatedAt,
		tags: input.tags ?? [],
		closed: isSessionClosed(input.messages),
		material: { titles: nodes.slice(0, CARD_MATERIAL_MAX).map((n) => n.title), more: Math.max(0, nodes.length - CARD_MATERIAL_MAX) },
		progress: nodes.length > 0 ? { covered: coverage.covered, total: coverage.total } : null,
		completion: completion
			? {
					status: completion.status,
					line: completionLine(completion),
					best: completion.best ? { grade: completion.best.result.grade, percent: completion.best.result.percent, passed: completion.best.result.passed } : null,
				}
			: null,
		notes: {
			written: input.pages.filter((p) => !p.skipped).length,
			sessions: input.pages.length,
			latest: latestNoteLine(input.pages),
		},
	};
}

/** The folder header's line: "3 sessions · 2 tags · 1 file". */
export function folderSummaryLine(cards: readonly SessionCard[], fileCount: number): string {
	const tags = new Set(cards.flatMap((c) => c.tags));
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const parts = [plural(cards.length, "session", "sessions")];
	if (tags.size > 0) parts.push(plural(tags.size, "tag", "tags"));
	if (fileCount > 0) parts.push(plural(fileCount, "file", "files"));
	return parts.join(" · ");
}

/** Cards in the order the learner would want them: what is in progress first
 *  (most recently studied), then the rest by recency. Pure; stable. */
export function sortCards(cards: readonly SessionCard[]): SessionCard[] {
	const rank = (c: SessionCard) => (c.completion?.status === "completed" ? 1 : 0);
	return [...cards].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}
