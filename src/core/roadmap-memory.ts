/**
 * Roadmap MEMORY — pure, browser-safe, no IO, no model.
 *
 * One chat per unit means a new chat starts with no conversation behind it.
 * What carries across is written down per unit (progress.json): how the unit
 * went, the misconceptions the learner held, whether they were resolved. This
 * module decides WHICH earlier units matter for the unit about to be taught
 * (the ones it builds on, and nearby ones the learner struggled with) and
 * writes the brief the teacher reads before teaching — a few lines of what
 * helps, never the whole history.
 *
 * Also here: the mastery rule (80%, code-computed — never the model's claim).
 */

import type { Misconception, PageRange, ProgressDoc, RoadmapDoc, RoadmapTopic, StruggleLevel, TopicStatus } from "./contracts/roadmap.ts";
import { roadmapCounts, statusOf, type RoadmapCounts } from "./roadmap.ts";

// ─── mastery ─────────────────────────────────────────────────────────────────

/** A unit is mastered when the checkpoint score reaches this (owner, 2026-11-24). */
export const MASTERY_THRESHOLD = 0.8;

/** The verdict for a checkpoint attempt from its item scores (each 0–1).
 *  No scores = no verdict (null): a unit can't be mastered without being checked. */
export function masteryVerdict(scores: readonly number[], threshold: number = MASTERY_THRESHOLD): { status: "mastered" | "shaky"; percent: number } | null {
	const valid = scores.filter((s) => Number.isFinite(s)).map((s) => Math.min(1, Math.max(0, s)));
	if (valid.length === 0) return null;
	const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
	// Compare on the exact mean; show the percent rounded DOWN, so a 79.5% that
	// did not pass is never displayed as "80%".
	return { status: mean + 1e-9 >= threshold ? "mastered" : "shaky", percent: Math.floor(mean * 100 + 1e-9) };
}

// ─── which earlier units matter ──────────────────────────────────────────────

export interface UnitMemory {
	unitId: string;
	title: string;
	/** 1 = a direct prerequisite, 2 = a prerequisite of a prerequisite. */
	distance: number;
	status: TopicStatus;
	attempts: number;
	struggle?: { level: StruggleLevel; summary: string };
	/** Unresolved first, then resolved ones. */
	misconceptions: Misconception[];
}

export interface MemoryOptions {
	maxDepth?: number;
	maxUnits?: number;
	maxMisconceptionsPerUnit?: number;
}

const STRUGGLE_RANK: Record<StruggleLevel, number> = { hard: 2, some: 1, smooth: 0 };

function worthCarrying(m: UnitMemory): boolean {
	return m.status === "shaky" || (m.struggle !== undefined && m.struggle.level !== "smooth") || m.attempts >= 2 || m.misconceptions.some((x) => !x.resolved);
}

/** The units that build up to `topicId` (up to `maxDepth` steps back) whose
 *  history is worth carrying forward, most useful first: unresolved
 *  misconceptions, then how hard it was, then how close the connection is. */
export function relatedMemories(roadmap: RoadmapDoc, progress: ProgressDoc | null | undefined, topicId: string, opts: MemoryOptions = {}): UnitMemory[] {
	const maxDepth = opts.maxDepth ?? 2;
	const maxUnits = opts.maxUnits ?? 6;
	const perUnit = opts.maxMisconceptionsPerUnit ?? 4;
	const byId = new Map(roadmap.topics.map((t) => [t.id, t]));
	const order = new Map(roadmap.topics.map((t, i) => [t.id, i]));
	const start = byId.get(topicId);
	if (!start) return [];

	const distance = new Map<string, number>();
	let frontier: RoadmapTopic[] = [start];
	for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
		const next: RoadmapTopic[] = [];
		for (const topic of frontier) {
			for (const id of topic.prereqs) {
				const prereq = byId.get(id);
				if (!prereq || id === topicId || distance.has(id)) continue;
				distance.set(id, d);
				next.push(prereq);
			}
		}
		frontier = next;
	}

	const memories: UnitMemory[] = [];
	for (const [id, d] of distance) {
		const topic = byId.get(id)!;
		const p = progress?.topics[id];
		const unresolvedFirst = [...(p?.misconceptions ?? [])].sort((a, b) => Number(a.resolved) - Number(b.resolved)).slice(0, perUnit);
		const memory: UnitMemory = {
			unitId: id,
			title: topic.title,
			distance: d,
			status: statusOf(progress, id),
			attempts: p?.attempts ?? 0,
			...(p?.struggle ? { struggle: p.struggle } : {}),
			misconceptions: unresolvedFirst,
		};
		if (worthCarrying(memory)) memories.push(memory);
	}
	const open = (m: UnitMemory) => m.misconceptions.filter((x) => !x.resolved).length;
	memories.sort(
		(a, b) =>
			open(b) - open(a) ||
			STRUGGLE_RANK[b.struggle?.level ?? "smooth"] - STRUGGLE_RANK[a.struggle?.level ?? "smooth"] ||
			a.distance - b.distance ||
			order.get(a.unitId)! - order.get(b.unitId)!,
	);
	return memories.slice(0, maxUnits);
}

// ─── the brief ───────────────────────────────────────────────────────────────

export interface RoadmapBriefInput {
	roadmap: RoadmapDoc;
	progress: ProgressDoc | null | undefined;
	topicId: string;
	/** How a page range is cited to the learner ("Mankiw p. 61–86 (PDF 97–122)"). */
	cite: (range: PageRange) => string;
}

export interface RoadmapBriefDetails {
	unit: { id: string; title: string; stage?: string; pages: string[] };
	counts: RoadmapCounts;
	/** The learner has been in this unit before. */
	resuming: boolean;
	lastStop?: string;
	memories: UnitMemory[];
	/** Shaky units that are not part of this unit's background — worth a later review. */
	otherShaky: { id: string; title: string }[];
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** The brief the teacher reads before teaching a unit, plus the structured
 *  details the learner's start card shows. Null for an unknown unit. */
export function roadmapBrief(input: RoadmapBriefInput): { text: string; details: RoadmapBriefDetails } | null {
	const { roadmap, progress, topicId, cite } = input;
	const topic = roadmap.topics.find((t) => t.id === topicId);
	if (!topic) return null;
	const counts = roadmapCounts(roadmap, progress);
	const mine = progress?.topics[topicId];
	const memories = relatedMemories(roadmap, progress, topicId);
	const inMemory = new Set(memories.map((m) => m.unitId));
	const background = new Set<string>();
	for (const m of relatedMemories(roadmap, progress, topicId, { maxUnits: 1000, maxDepth: 2 })) background.add(m.unitId);
	const otherShaky = roadmap.topics.filter((t) => t.id !== topicId && !inMemory.has(t.id) && !background.has(t.id) && statusOf(progress, t.id) === "shaky").slice(0, 3).map((t) => ({ id: t.id, title: t.title }));
	const pages = [topic.anchor, ...(topic.seeAlso ?? [])].filter((r): r is PageRange => r !== undefined).map(cite);
	const resuming = mine !== undefined && (mine.status === "learning" || mine.status === "shaky" || mine.lastStop !== undefined);

	const lines: string[] = [];
	lines.push("ROADMAP BRIEF — read this before teaching. The learner sees a short card with the same facts.");
	lines.push("");
	lines.push(`Progress: ${counts.mastered} of ${counts.total} units mastered, ${counts.shaky} shaky, ${counts.learning} in progress.`);
	lines.push(`Unit to teach now: ${topic.id} — ${topic.title}${topic.stage ? ` (stage ${topic.stage})` : ""}${topic.flags?.length ? ` [${topic.flags.join(", ")}]` : ""}.`);
	if (pages.length > 0) lines.push(`Book pages for this unit: ${pages.join("; ")}. Teach from these pages only — load them with get_pages, a few at a time, and cite them.`);
	if (topic.chapters) lines.push(`Chapters: ${topic.chapters}.`);
	if (topic.prereqs.length > 0) lines.push(`Builds on: ${topic.prereqs.map((id) => `${id} (${statusOf(progress, id).replace("_", " ")})`).join(", ")}.`);
	if (topic.own) lines.push(`The learner should come to own: ${topic.own}`);
	if (topic.checkpoint?.length) {
		lines.push("Checkpoint — the learner must do these without notes:");
		for (const item of topic.checkpoint) lines.push(`- ${item}`);
	}
	if (resuming) {
		lines.push("");
		lines.push(`The learner has been in this unit before (status: ${mine!.status.replace("_", " ")}, ${mine!.attempts ?? 0} checkpoint attempt${(mine!.attempts ?? 0) === 1 ? "" : "s"}).${mine!.lastStop ? ` Last time they stopped at: ${mine!.lastStop}` : ""}`);
	}
	if (memories.length > 0) {
		lines.push("");
		lines.push("MEMORY from earlier units this one builds on (use it to teach better: connect to it, probe an old misconception gently — never recite it back as a list):");
		for (const m of memories) {
			const how = m.struggle ? `${m.struggle.level === "smooth" ? "went smoothly" : m.struggle.level === "some" ? "some struggle" : "a hard unit"} — ${clip(m.struggle.summary, 240)}` : m.status === "shaky" ? "left shaky" : "no notes";
			lines.push(`- ${m.unitId} ${m.title} (${m.distance === 1 ? "direct prerequisite" : "two steps back"}; ${m.status.replace("_", " ")}${m.attempts >= 2 ? `, ${m.attempts} attempts` : ""}): ${how}`);
			for (const x of m.misconceptions) lines.push(`    • ${x.resolved ? "was resolved" : "STILL OPEN"}: believed "${clip(x.believed, 160)}" — actually: ${clip(x.correct, 160)}`);
		}
	} else if (topic.prereqs.length > 0) {
		lines.push("");
		lines.push("MEMORY: the units this one builds on went smoothly; nothing to carry over.");
	}
	if (otherShaky.length > 0) lines.push(`\nOther units still shaky (not this session's job, but worth a review soon): ${otherShaky.map((s) => `${s.id} ${s.title}`).join("; ")}.`);

	return { text: lines.join("\n"), details: { unit: { id: topic.id, title: topic.title, ...(topic.stage ? { stage: topic.stage } : {}), pages }, counts, resuming, ...(mine?.lastStop ? { lastStop: mine.lastStop } : {}), memories, otherShaky } };
}
