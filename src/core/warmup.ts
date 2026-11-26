/**
 * WELCOME BACK — the warm-up for a learner returning to an idle session. Pure.
 *
 * After a few days away, what was learned has faded and the lesson's last
 * question reads as a stranger's. So before continuing, the session offers a
 * short WARM-UP: the teacher recaps what was covered and where it stopped, then
 * asks a few recall questions about the things most worth bringing back. The
 * research basis is retrieval practice — producing the answer from memory beats
 * rereading it — so the brief asks for recall in the learner's own words and
 * never for new material.
 *
 * This module decides everything that does not need a model:
 *   - WHEN to offer it (idle >= 3 days, a plan with at least one check, no
 *     question waiting);
 *   - WHAT to ask about (3 to 5 plan nodes, chosen from what the transcript
 *     says: prerequisites of where the session stopped, the checks the learner
 *     got confidently wrong / didn't know / was unsure of, then whatever has
 *     gone longest untouched) — no ability score, no model;
 *   - the BRIEF the teacher receives, as an injected marker message (so the
 *     teacher's own prompts are untouched).
 *
 * The questions are about PLAN nodes (the session's own units), and the marker
 * names them by id so the teacher's tagged checks line up with the plan.
 */

import type { PlanTree } from "./contracts/plan.ts";
import { derivePlanStatusesLh } from "./contracts/plan.ts";
import type { LhMessage } from "./native-messages.ts";
import { newestWrittenPage, struggleKindOf, type NotePage, type StruggleKind } from "./notes.ts";

/** Idle days before the gate appears (owner, 2026-11-06). */
export const WARMUP_IDLE_DAYS = 3;
/** The warm-up asks at least this many questions (when the plan has that many)… */
export const WARMUP_MIN_ITEMS = 3;
/** …and never more than this. */
export const WARMUP_MAX_ITEMS = 5;

const DAY_MS = 86_400_000;

/** Whole days since `updatedAt` (never negative; 0 when unparseable). */
export function idleDaysSince(updatedAt: string, now: number): number {
	const t = Date.parse(updatedAt);
	if (!Number.isFinite(t)) return 0;
	return Math.max(0, Math.floor((now - t) / DAY_MS));
}

// ─── eligibility ─────────────────────────────────────────────────────────────

export interface WarmupSubject {
	kind?: string;
	/** Present on a final-exam session. */
	exam?: unknown;
	tree?: PlanTree | null;
	messages: readonly LhMessage[];
}

/** Why a warm-up is structurally impossible right now, or null. (Idleness is a
 *  separate question — a learner may ask for a warm-up any time it is possible.) */
export function warmupBlocker(s: WarmupSubject): string | null {
	if (s.kind === "practice" || s.exam !== undefined) return "A warm-up is for teaching sessions.";
	if (!s.tree || s.tree.nodes.length === 0) return "There is no plan to warm up from yet.";
	if (derivePlanStatusesLh(s.tree, s.messages).current === null) return "Nothing has been covered yet.";
	// A check waiting for its answer does NOT block a warm-up: that is exactly
	// how a learner leaves a session. The warm-up pauses it (inputAppends) and
	// the teacher poses it again afterwards.
	return null;
}

/** Should the gate ("Warm up before continuing?") be shown on opening? */
export function warmupOffered(s: WarmupSubject & { updatedAt: string }, now: number): boolean {
	return warmupBlocker(s) === null && idleDaysSince(s.updatedAt, now) >= WARMUP_IDLE_DAYS;
}

// ─── what the transcript says about each plan node ───────────────────────────

interface NodeFact {
	id: string;
	title: string;
	summary?: string;
	/** Message index of the node's first / most recent tagged check. */
	firstIndex: number;
	lastIndex: number;
	struggles: StruggleKind[];
}

/** Per covered plan node: where it was first/last checked and how the learner
 *  did on its quiz answers. Only nodes the learner actually reached appear. */
function nodeFacts(tree: PlanTree, messages: readonly LhMessage[]): NodeFact[] {
	const byId = new Map(tree.nodes.map((n) => [n.id, n]));
	const facts = new Map<string, NodeFact>();
	const nodeOfCall = new Map<string, string>();
	messages.forEach((m, index) => {
		const msg = m as { role?: string; content?: unknown; toolName?: string; toolCallId?: string; details?: Record<string, unknown> };
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content as Array<{ type?: string; id?: string; name?: string; arguments?: { nodeId?: unknown } }>) {
				if (b?.type !== "toolCall" || (b.name !== "quiz" && b.name !== "explain") || typeof b.id !== "string") continue;
				const nodeId = b.arguments?.nodeId;
				const node = typeof nodeId === "string" ? byId.get(nodeId) : undefined;
				if (!node) continue;
				nodeOfCall.set(b.id, node.id);
				const fact = facts.get(node.id) ?? { id: node.id, title: node.title, summary: node.summary, firstIndex: index, lastIndex: index, struggles: [] };
				fact.lastIndex = index;
				facts.set(node.id, fact);
			}
		} else if (msg.role === "toolResult" && msg.toolName === "quiz" && typeof msg.toolCallId === "string") {
			const nodeId = nodeOfCall.get(msg.toolCallId);
			const kind = nodeId ? struggleKindOf(msg.details) : null;
			if (nodeId && kind) facts.get(nodeId)?.struggles.push(kind);
		}
	});
	return [...facts.values()].sort((a, b) => a.firstIndex - b.firstIndex);
}

/** Every node that is (transitively) a PREREQUISITE of `nodeId` — walking the
 *  plan's edges (from = prerequisite, to = dependent) backwards. */
function prerequisitesOf(tree: PlanTree, nodeId: string): Set<string> {
	const out = new Set<string>();
	const stack = [nodeId];
	while (stack.length > 0) {
		const at = stack.pop()!;
		for (const e of tree.edges) {
			if (e.to === at && !out.has(e.from)) {
				out.add(e.from);
				stack.push(e.from);
			}
		}
	}
	return out;
}

// ─── choosing the warm-up ────────────────────────────────────────────────────

export interface WarmupItem {
	nodeId: string;
	title: string;
	summary?: string;
	/** Why this one — shown to the learner and to the teacher. */
	reason: string;
}

export interface WarmupPlan {
	/** The plan nodes reached so far, in the order they were first checked. */
	covered: { id: string; title: string; summary?: string }[];
	/** Where the session stopped (the most recent tagged check's node), if any. */
	stoppedAt: { id: string; title: string; summary?: string } | null;
	/** The 3-5 nodes to warm up, in teaching order. */
	items: WarmupItem[];
}

const STRUGGLE_WEIGHT: Record<StruggleKind, number> = { "committed-misconception": 4, "dont-know": 3, wrong: 2, fragile: 1.5 };
const STRUGGLE_CAP = 6;
const PREREQUISITE_WEIGHT = 3;
const STALENESS_MAX = 2;
/** The node the session stopped in is about to be CONTINUED, not warmed up —
 *  unless the learner struggled there. */
const STOPPED_AT_PENALTY = 2;

/** How many questions for `covered` reached nodes: enough to touch the earlier
 *  material (one per node up to the cap) but never a long quiz. */
export function warmupSize(covered: number): number {
	return Math.min(WARMUP_MAX_ITEMS, Math.max(WARMUP_MIN_ITEMS, covered));
}

function reasonOf(struggles: readonly StruggleKind[], prerequisite: boolean, stale: boolean): string {
	const parts: string[] = [];
	if (struggles.includes("committed-misconception")) parts.push("you were confidently wrong here");
	else if (struggles.includes("dont-know")) parts.push("you didn't know this one");
	else if (struggles.includes("wrong")) parts.push("you answered this one wrong");
	else if (struggles.includes("fragile")) parts.push("you were unsure here");
	if (prerequisite) parts.push("it is a prerequisite of where you stopped");
	if (parts.length === 0) parts.push(stale ? "it has gone longest without a check" : "covered earlier");
	return parts.join("; ");
}

/** Pick what to warm up. Pure: reads the plan and the transcript only. */
export function planWarmup(tree: PlanTree, messages: readonly LhMessage[]): WarmupPlan {
	const facts = nodeFacts(tree, messages);
	const current = derivePlanStatusesLh(tree, messages).current;
	const covered = facts.map((f) => ({ id: f.id, title: f.title, ...(f.summary ? { summary: f.summary } : {}) }));
	const stopFact = facts.find((f) => f.id === current);
	const stoppedAt = stopFact ? { id: stopFact.id, title: stopFact.title, ...(stopFact.summary ? { summary: stopFact.summary } : {}) } : null;
	if (facts.length === 0) return { covered, stoppedAt, items: [] };

	const prereqs = current ? prerequisitesOf(tree, current) : new Set<string>();
	// Staleness: the node checked LONGEST ago scores the most (linear by rank).
	const byAge = [...facts].sort((a, b) => a.lastIndex - b.lastIndex);
	const staleRank = new Map(byAge.map((f, i) => [f.id, byAge.length > 1 ? 1 - i / (byAge.length - 1) : 0]));

	const scored = facts.map((f) => {
		const isPrereq = prereqs.has(f.id);
		const struggle = Math.min(STRUGGLE_CAP, f.struggles.reduce((sum, k) => sum + STRUGGLE_WEIGHT[k], 0));
		const staleness = (staleRank.get(f.id) ?? 0) * STALENESS_MAX;
		const score = struggle + (isPrereq ? PREREQUISITE_WEIGHT : 0) + staleness - (f.id === current && struggle === 0 ? STOPPED_AT_PENALTY : 0);
		return { f, score, isPrereq, stale: (staleRank.get(f.id) ?? 0) >= 0.75 };
	});

	const k = Math.min(warmupSize(facts.length), scored.length);
	const chosen = [...scored].sort((a, b) => b.score - a.score || a.f.firstIndex - b.f.firstIndex).slice(0, k);
	// Teaching order, so the recap and the questions read as a walk through the plan.
	chosen.sort((a, b) => a.f.firstIndex - b.f.firstIndex);
	return {
		covered,
		stoppedAt,
		items: chosen.map(({ f, isPrereq, stale }) => ({
			nodeId: f.id,
			title: f.title,
			...(f.summary ? { summary: f.summary } : {}),
			reason: reasonOf(f.struggles, isPrereq, stale),
		})),
	};
}

// ─── the learner's own notes, as brief context ───────────────────────────────

const NOTES_BRIEF_CHARS = 1600;

/** The newest notes page, condensed: what it said was learned, where the
 *  learner got stuck, which misconceptions they had. Empty when no notes. */
export function lastNotesBrief(pages: readonly NotePage[]): string {
	const page = newestWrittenPage(pages);
	if (!page) return "";
	const lines: string[] = [];
	if (page.summary) lines.push(page.summary);
	if (page.concepts.length > 0) lines.push(`Concepts: ${page.concepts.map((c) => c.title).join("; ")}`);
	if (page.stuck.length > 0) lines.push(`Got stuck on: ${page.stuck.join("; ")}`);
	if (page.misconceptions.length > 0) lines.push(`Misconceptions: ${page.misconceptions.map((m) => `believed "${m.believed}" — actually ${m.correct}`).join("; ")}`);
	const text = lines.join("\n");
	return text.length > NOTES_BRIEF_CHARS ? `${text.slice(0, NOTES_BRIEF_CHARS)}…` : text;
}

// ─── the brief ───────────────────────────────────────────────────────────────

/** The model-facing text of the welcome-back marker. It plays the role of
 *  injected session context (bracket-labelled, never the learner's voice). */
export function warmupBrief(input: { idleDays: number; plan: WarmupPlan; notesBrief: string; pausedCheck?: string }): string {
	const { idleDays, plan, notesBrief, pausedCheck } = input;
	const line = (title: string, summary?: string) => (summary ? `${title} — ${summary}` : title);
	const out: string[] = [
		`[Welcome back] — the learner is returning to this session after ${idleDays} day${idleDays === 1 ? "" : "s"} away. Before continuing, run a short warm-up so what they learned comes back to mind.`,
		"",
		"What the session has covered, in order:",
		...plan.covered.map((c, i) => `${i + 1}. ${line(c.title, c.summary)}`),
		"",
		plan.stoppedAt ? `Where it stopped: ${line(plan.stoppedAt.title, plan.stoppedAt.summary)}.` : "Where it stopped: (no check yet).",
	];
	if (notesBrief) out.push("", "From the learner's own notes of the last session:", notesBrief);
	out.push(
		"",
		`Warm-up items (${plan.items.length}) — ask about these, one at a time, in this order; tag each question with the item's node id:`,
		...plan.items.map((it, i) => `${i + 1}. [${it.nodeId}] ${line(it.title, it.summary)} — chosen because ${it.reason}`),
		"",
		"How to run it:",
		"- Open with a short recap (three or four sentences, in the learner's language): what was covered, ending at where it stopped.",
		"- Then ask the warm-up questions one at a time. Each must make the learner RECALL or reconstruct something from its item in their own words — prefer the free-recall check over a multiple-choice one — never a bare recognition or yes/no check, and never new material. A question may span two items when they connect.",
		"- Judge each answer as it comes. If an answer shows a foundation has gone missing, re-teach just that piece briefly, then re-ask it in a changed form before moving on.",
		`- Keep it short: at most ${plan.items.length} questions, and stop early if the first three answers are clean.`,
		"- When the warm-up is done, say so in one line and continue the lesson from where it stopped.",
	);
	if (pausedCheck !== undefined) {
		out.push(
			"",
			`The learner's last check${pausedCheck ? ` ("${pausedCheck}")` : ""} was still waiting for an answer and has been PAUSED for this warm-up. After the warm-up, pose that same check again (same question and options) before any new material.`,
		);
	}
	return out.join("\n");
}

/** The marker card's payload (the transcript's face of the brief). */
export interface WelcomeBackDetails {
	idleDays: number;
	covered: string[];
	stoppedAt: string | null;
	items: { nodeId: string; title: string; reason: string }[];
}

export function welcomeBackDetails(idleDays: number, plan: WarmupPlan): WelcomeBackDetails {
	return {
		idleDays,
		covered: plan.covered.map((c) => c.title),
		stoppedAt: plan.stoppedAt?.title ?? null,
		items: plan.items.map((i) => ({ nodeId: i.nodeId, title: i.title, reason: i.reason })),
	};
}
