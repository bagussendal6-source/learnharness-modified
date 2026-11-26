import { ChatInputError } from "../core/input-events.ts";
import type { ChatRecord } from "../core/contracts.ts";
import { danglingQuestionOf, newWelcomeBackMessage, type LhMarkerMessage } from "../core/native-messages.ts";
import {
	idleDaysSince,
	lastNotesBrief,
	planWarmup,
	warmupBlocker,
	warmupBrief,
	warmupOffered,
	welcomeBackDetails,
	WARMUP_IDLE_DAYS,
	type WarmupPlan,
} from "../core/warmup.ts";
import { stores } from "./stores.ts";

/**
 * WELCOME BACK, server side (core/warmup.ts decides everything).
 *
 * The learner presses "Warm up" → the client sends the bare `warmup` input →
 * chat-handler calls buildWarmupMarker(record) and hands the marker to the pure
 * append. The marker IS the brief (user-role context for the teacher), so no
 * prompt is touched. Nothing is stored beyond that one marker message.
 */

/** The marker for `record`, built from its plan, transcript and notes. Throws
 *  ChatInputError (→ the honest 400) when a warm-up is impossible right now. */
export function buildWarmupMarker(record: ChatRecord, now: number = Date.now()): LhMarkerMessage {
	const blocker = warmupBlocker(record);
	if (blocker) throw new ChatInputError(blocker);
	const plan = planWarmup(record.tree!, record.messages);
	if (plan.items.length === 0) throw new ChatInputError("Nothing has been covered yet.");
	const idleDays = idleDaysSince(record.updatedAt, now);
	const notesBrief = lastNotesBrief(stores.notesStore.readNotes(record.id)?.pages ?? []);
	// A check that was waiting for its answer is paused by the input (core/input-events);
	// the brief names it so the teacher poses it again afterwards.
	const waiting = danglingQuestionOf(record.messages);
	const waitingQuestion = (waiting?.input as { question?: unknown } | null | undefined)?.question;
	const pausedCheck = waiting ? (typeof waitingQuestion === "string" ? waitingQuestion : "") : undefined;
	return newWelcomeBackMessage(warmupBrief({ idleDays, plan, notesBrief, pausedCheck }), welcomeBackDetails(idleDays, plan));
}

export interface WarmupOffer {
	/** Show the gate: idle past the threshold and a warm-up is possible. */
	offer: boolean;
	/** A warm-up CAN be run right now (whatever the idle time) — the header's
	 *  always-there "Warm up" button keys on this, not on idleness. */
	available: boolean;
	idleDays: number;
	thresholdDays: number;
	/** Why a warm-up is impossible (null when possible). */
	blocker: string | null;
	/** What the warm-up would cover — shown on the gate card. */
	plan: Pick<WarmupPlan, "covered" | "stoppedAt"> & { items: { nodeId: string; title: string; reason: string }[] };
}

/** The gate's data for one session; null for an unknown chat. */
export function warmupOfferFor(chatId: string, now: number = Date.now()): WarmupOffer | null {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return null;
	const blocker = warmupBlocker(chat);
	const plan = blocker || !chat.tree ? { covered: [], stoppedAt: null, items: [] } : planWarmup(chat.tree, chat.messages);
	return {
		offer: warmupOffered(chat, now) && plan.items.length > 0,
		available: blocker === null && plan.items.length > 0,
		idleDays: idleDaysSince(chat.updatedAt, now),
		thresholdDays: WARMUP_IDLE_DAYS,
		blocker,
		plan: { covered: plan.covered, stoppedAt: plan.stoppedAt, items: plan.items.map((i) => ({ nodeId: i.nodeId, title: i.title, reason: i.reason })) },
	};
}
