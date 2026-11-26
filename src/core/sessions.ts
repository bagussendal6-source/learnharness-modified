/**
 * SESSIONS INSIDE ONE CHAT — the pure folds behind the folded transcript and
 * the Sessions panel.
 *
 * A chat is one material; Close session splits it into sessions (core/notes.ts
 * owns the boundaries: each notes page — written or "closed without notes" —
 * ends one session at its toMessageId; the open session is everything after the
 * last one). Here:
 *   - sessionFolds(): which transcript rows belong to which FINISHED session,
 *     so the chat can fold them into one line each instead of one long scroll;
 *   - sessionStats(): per session, what happened — plan steps first reached,
 *     checks answered and right, whether it opened with a warm-up, and when.
 * No model, no storage: folds over the record the app already keeps.
 */

import type { PlanTree } from "./contracts/plan.ts";
import type { LhMessage } from "./native-messages.ts";
import type { NotePage } from "./notes.ts";

// ─── one page per session ────────────────────────────────────────────────────

interface ViewRow {
	role: string;
	parts: ReadonlyArray<{ type: string; data?: unknown }>;
}

/** One session of the transcript, as a range of VIEW rows. */
export interface SessionRange {
	/** 1-based session number. */
	session: number;
	/** First row, and last row (a finished session's last row is its closed label). */
	start: number;
	end: number;
	/** Conversation rows (learner + teacher) it holds — markers and cards excluded. */
	rows: number;
	/** Finished sessions only: notes were written when it closed. */
	notes: boolean;
}

function closedLabel(row: ViewRow): { pageNumber?: number; notes?: boolean } | null {
	for (const p of row.parts) {
		if (p.type !== "data-session-boundary") continue;
		const d = (p.data ?? {}) as { kind?: string; pageNumber?: number; notes?: boolean };
		if (d.kind === "session-closed") return d;
	}
	return null;
}

/** Split the transcript into its sessions: each closed label ends one finished
 *  session; everything after the last label is the CURRENT session (empty right
 *  after a close — the next session has not said anything yet). */
export function sessionRanges(rows: readonly ViewRow[]): { finished: SessionRange[]; current: { session: number; start: number } } {
	const finished: SessionRange[] = [];
	let start = 0;
	for (let i = 0; i < rows.length; i++) {
		const label = closedLabel(rows[i]!);
		if (!label) continue;
		let count = 0;
		for (let j = start; j < i; j++) {
			const role = rows[j]!.role;
			const markerOnly = rows[j]!.parts.length > 0 && rows[j]!.parts.every((p) => p.type.startsWith("data-"));
			if ((role === "user" || role === "assistant") && !markerOnly) count++;
		}
		finished.push({ session: finished.length + 1, start, end: i, rows: count, notes: label.notes === true });
		start = i + 1;
	}
	return { finished, current: { session: finished.length + 1, start } };
}

/** Which rows the chat page shows: the session in the URL when it is a finished
 *  one (READ-ONLY — only the current session has a teacher), otherwise the
 *  current session. */
export function viewedSession(
	ranges: ReturnType<typeof sessionRanges>,
	requested: number | null,
): { session: number; start: number; end: number; readOnly: boolean } {
	const past = requested === null ? undefined : ranges.finished.find((f) => f.session === requested);
	if (past) return { session: past.session, start: past.start, end: past.end, readOnly: true };
	return { session: ranges.current.session, start: ranges.current.start, end: Number.POSITIVE_INFINITY, readOnly: false };
}

// ─── what happened in each session ───────────────────────────────────────────

export interface SessionStat {
	/** 1-based session number (= the notes page number for closed sessions). */
	session: number;
	/** True for the open session (no page yet). */
	current: boolean;
	/** Plan steps reached for the FIRST time in this session, in order. */
	newSteps: string[];
	/** Quiz checks answered in this session (dismissed / paused ones excluded). */
	checks: number;
	correct: number;
	/** The session opened with a warm-up. */
	warmup: boolean;
	/** Earliest / latest message time in the session (ISO), when known. */
	from: string | null;
	to: string | null;
}

function slices(messages: readonly LhMessage[], pages: readonly NotePage[]): { session: number; current: boolean; from: number; to: number }[] {
	const out: { session: number; current: boolean; from: number; to: number }[] = [];
	let from = 0;
	for (const page of pages) {
		const end = messages.findIndex((m) => (m as { id?: string }).id === page.toMessageId);
		if (end < 0) continue; // a boundary no longer in the transcript: skip it honestly
		out.push({ session: page.n, current: false, from, to: end });
		from = end + 1;
	}
	if (from < messages.length) {
		const hasActivity = messages.slice(from).some((m) => {
			const role = (m as { role?: string }).role;
			return role === "user" || role === "toolResult";
		});
		if (hasActivity) out.push({ session: pages.length + 1, current: true, from, to: messages.length - 1 });
	}
	return out;
}

const iso = (t: unknown): string | null => (typeof t === "number" && Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null);

/** Per session: steps first reached, checks right/answered, warm-up, when. */
export function sessionStats(messages: readonly LhMessage[], pages: readonly NotePage[], tree: PlanTree | null | undefined): SessionStat[] {
	const titles = new Map((tree?.nodes ?? []).map((n) => [n.id, n.title]));
	// Where each plan node was FIRST reached (by a tagged check), whole chat.
	const firstReach = new Map<string, number>();
	messages.forEach((m, i) => {
		const msg = m as { role?: string; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
		for (const b of msg.content as Array<{ type?: string; name?: string; arguments?: { nodeId?: unknown } }>) {
			if (b?.type !== "toolCall" || (b.name !== "quiz" && b.name !== "explain")) continue;
			const id = b.arguments?.nodeId;
			if (typeof id === "string" && titles.has(id) && !firstReach.has(id)) firstReach.set(id, i);
		}
	});
	return slices(messages, pages).map(({ session, current, from, to }) => {
		const newSteps = [...firstReach.entries()].filter(([, at]) => at >= from && at <= to).sort((a, b) => a[1] - b[1]).map(([id]) => titles.get(id)!);
		let checks = 0;
		let correct = 0;
		let warmup = false;
		let first: number | null = null;
		let last: number | null = null;
		for (let i = from; i <= to; i++) {
			const m = messages[i] as { role?: string; toolName?: string; customType?: string; details?: Record<string, unknown>; timestamp?: unknown };
			if (typeof m.timestamp === "number" && m.timestamp > 0) {
				first = first === null ? m.timestamp : Math.min(first, m.timestamp);
				last = last === null ? m.timestamp : Math.max(last, m.timestamp);
			}
			if (m.role === "custom" && m.customType === "welcome-back") warmup = true;
			if (m.role === "toolResult" && m.toolName === "quiz" && m.details && m.details.dismissed !== true) {
				checks++;
				if (m.details.correct === true) correct++;
			}
		}
		return { session, current, newSteps, checks, correct, warmup, from: iso(first), to: iso(last) };
	});
}

/** The one-line digest a session row shows: "+3 steps · 5/7 checks · warm-up". */
export function sessionStatLine(s: SessionStat): string {
	const parts: string[] = [];
	if (s.newSteps.length > 0) parts.push(`+${s.newSteps.length} step${s.newSteps.length === 1 ? "" : "s"}`);
	if (s.checks > 0) parts.push(`${s.correct}/${s.checks} checks`);
	if (s.warmup) parts.push("warm-up");
	return parts.join(" · ");
}
