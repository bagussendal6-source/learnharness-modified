/**
 * Checking a roadmap's page ranges against the books it points at — pure.
 *
 * The roadmap says where each unit lives ("Hull Ch 3 · PDF pp. 75–102"); the
 * books' own tables of contents say where each chapter starts and ends. A
 * range that begins and ends on chapter boundaries is almost certainly right;
 * one that doesn't is shown to the learner before anything is approved. This
 * never edits a range — it only reports.
 */

import type { PageRange, RoadmapDoc } from "./contracts/roadmap.ts";

/** What the check needs to know about one ingested book. */
export interface BookView {
	pages: number;
	/** Table-of-contents spans (any depth); empty when the book has none. */
	outline: readonly { depth: number; startPage: number; endPage: number }[];
}

/** "pending" = a book the unit needs has not been added yet (not an error in the roadmap). */
export type CheckLevel = "ok" | "pending" | "warn" | "error";

export interface TopicCheck {
	topicId: string;
	level: CheckLevel;
	notes: string[];
}

/** How far (in pages) a range edge may sit from a chapter edge and still count as on it. */
const SLACK = 1;

function checkRange(range: PageRange, book: BookView | null, label: string): { level: CheckLevel; note: string }[] {
	if (!book) return [{ level: "pending", note: `${label}: the book isn't added yet.` }];
	const where = `${label} PDF pp. ${range.start}–${range.end}`;
	if (range.start < 1 || range.end > book.pages) return [{ level: "error", note: `${where} runs outside the book (${book.pages} pages).` }];
	const chapters = book.outline.filter((n) => n.depth <= 1);
	if (chapters.length === 0) return [];
	const out: { level: CheckLevel; note: string }[] = [];
	if (!chapters.some((n) => Math.abs(n.startPage - range.start) <= SLACK)) out.push({ level: "warn", note: `${where}: page ${range.start} is not where a chapter or part starts.` });
	if (!chapters.some((n) => Math.abs(n.endPage - range.end) <= SLACK)) out.push({ level: "warn", note: `${where}: page ${range.end} is not where a chapter or part ends.` });
	return out;
}

/** One result per topic, worst level wins. `bookOf` resolves a range's book key. */
export function verifyRoadmap(roadmap: RoadmapDoc, bookOf: (key: string) => BookView | null): TopicCheck[] {
	const labelOf = new Map((roadmap.books ?? []).map((b) => [b.key, b.label]));
	return roadmap.topics.map((topic) => {
		const ranges = [topic.anchor, ...(topic.seeAlso ?? [])].filter((r): r is PageRange => r !== undefined);
		if (ranges.length === 0) return { topicId: topic.id, level: "error", notes: ["No pages are listed for this unit."] };
		const found = ranges.flatMap((r) => checkRange(r, bookOf(r.book), labelOf.get(r.book) ?? r.book));
		const has = (l: CheckLevel) => found.some((f) => f.level === l);
		const level: CheckLevel = has("error") ? "error" : has("warn") ? "warn" : has("pending") ? "pending" : "ok";
		return { topicId: topic.id, level, notes: [...new Set(found.map((f) => f.note))] };
	});
}

export function checkCounts(checks: readonly TopicCheck[]): { ok: number; pending: number; warn: number; error: number } {
	const n = (level: CheckLevel) => checks.filter((c) => c.level === level).length;
	return { ok: n("ok"), pending: n("pending"), warn: n("warn"), error: n("error") };
}
