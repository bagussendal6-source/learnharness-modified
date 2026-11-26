/**
 * Session titles — the pure half of the AI namer.
 *
 * A new session is titled from the learner's first message (titleFromPrompt,
 * contracts/graph.ts) — often a raw prompt. Once the teacher has replied there
 * is enough context for a model to name the MATERIAL instead. The model call
 * lives in src/server/title-suggest.ts; everything decidable without a model
 * lives here so it is deterministic and unit-tested:
 *
 *   - who may be (re)named automatically (`autoTitleEligible`, `needsTitle`)
 *   - the transcript slice the namer reads (`transcriptDigest`)
 *   - cleaning the model's answer into a title (`sanitizeTitle`)
 *
 * The one law: a title the learner chose (`titleSource === "manual"`) is never
 * replaced by the automatic namer.
 */

import { TITLE_MAX_CHARS, titleFromPrompt } from "./contracts/graph.ts";
import type { TitleSource } from "./contracts/chat.ts";
import { userFacingTextOf } from "./native-messages.ts";

/** How much transcript the namer reads (chars) — same budget as tag-suggest. */
export const TITLE_DIGEST_CHARS = 3500;
/** Per-message cap inside the digest. */
const DIGEST_LINE_CHARS = 900;

/** Absent provenance reads as "prompt" (every pre-titleSource record). */
export function titleSourceOf(record: { titleSource?: TitleSource }): TitleSource {
	return record.titleSource ?? "prompt";
}

/** True when the title is still the raw first-prompt cut — i.e. nobody (model
 *  or learner) has named the session yet. This is the BULK "Generate names"
 *  filter and the first half of the auto-namer's gate. */
export function needsTitle(record: { titleSource?: TitleSource }): boolean {
	return titleSourceOf(record) === "prompt";
}

interface MessageLike {
	role?: string;
	content?: unknown;
}

function textOf(message: MessageLike): string {
	return userFacingTextOf(message.content).join("\n").trim();
}

/** Learner/Teacher transcript, oldest first, capped at `maxChars` — the
 *  namer's whole view of the session. Non-conversational messages (tool
 *  results, markers) and empty ones are skipped. */
export function transcriptDigest(messages: readonly MessageLike[], maxChars: number = TITLE_DIGEST_CHARS): string {
	const lines: string[] = [];
	let used = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textOf(message);
		if (!text) continue;
		const line = `${message.role === "user" ? "Learner" : "Teacher"}: ${text}`.slice(0, DIGEST_LINE_CHARS);
		lines.push(line);
		used += line.length;
		if (used >= maxChars) break;
	}
	return lines.join("\n\n");
}

/** Does the transcript hold at least one learner message AND one teacher reply
 *  with visible text? (The auto-namer's trigger: "after the first teacher
 *  reply" — before that the first prompt IS the best context there is.) */
export function hasTeacherReply(messages: readonly MessageLike[]): boolean {
	let learner = false;
	for (const message of messages) {
		if (message.role === "user" && textOf(message)) learner = true;
		else if (message.role === "assistant" && learner && textOf(message)) return true;
	}
	return false;
}

/** The automatic namer's full gate: the title is still the raw prompt cut AND
 *  the teacher has replied at least once. */
export function autoTitleEligible(record: { titleSource?: TitleSource; messages: readonly MessageLike[] }): boolean {
	return needsTitle(record) && hasTeacherReply(record.messages);
}

/** Clean a model's title answer: first line only, no markdown/quotes/label,
 *  no trailing period, whitespace collapsed, clamped to TITLE_MAX_CHARS at a
 *  word boundary. Returns "" when nothing usable is left. */
export function sanitizeTitle(raw: unknown): string {
	if (typeof raw !== "string") return "";
	let text = raw.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
	// Order matters: shed wrapping quotes/markdown first so a label hiding
	// behind them ("Title: ...") is reachable, then the label, then whatever
	// markdown the label itself was wrapping.
	const lead = /^[\s#>*_`"'“”‘’]+/;
	text = text
		.replace(lead, "")
		.replace(/^(?:title|judul)\s*[:：-]\s*/i, "")
		.replace(lead, "")
		.replace(/[\s*_`"'“”‘’.。]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return "";
	// titleFromPrompt already snaps to a word boundary at/under the cap; for a
	// model title that fits (the normal case) it returns the text untouched.
	const clamped = titleFromPrompt(text);
	return clamped.length <= TITLE_MAX_CHARS + 1 ? clamped : clamped.slice(0, TITLE_MAX_CHARS + 1);
}
