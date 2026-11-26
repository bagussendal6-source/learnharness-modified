import { Type } from "typebox";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import { connectionBackgroundAllowed } from "../agent/subscription-connections.ts";
import { autoTitleEligible, sanitizeTitle, transcriptDigest } from "../core/title.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { stores } from "./stores.ts";

/**
 * AI session TITLES: one small submit-agent call on the cheap tier ("auditor"
 * role — the same slot tag suggestions and extraction use) reads the opening
 * of the transcript and names the MATERIAL being learned, instead of the
 * raw first prompt the session is born with.
 *
 * Two entry points:
 *   - suggestTitle(): the learner asked ("Generate name"). Returns a
 *     proposal only — nothing is saved until the learner accepts it
 *     (PUT /api/chats/:id {title} → titleSource "manual").
 *   - autoTitleChat(): fired in the background after a turn settles. Applies
 *     the title itself, but ONLY while titleSource is still "prompt" (a
 *     learner-chosen or earlier AI title is never overwritten), and only
 *     once the teacher has replied. Any failure is silent: the prompt
 *     title simply stays.
 *
 * Usage is not added to the session's cost log (same as tag suggestions).
 */

const INSTRUCTIONS = `You name study sessions.
Given the start of a session transcript, call submit_title with ONE short title that says what MATERIAL is being learned
(e.g. "Teorema Green: hubungan integral garis dan lipat dua"), not what the learner typed and not the activity
("question", "chat", "help").
Rules: at most 70 characters; no quotes, no trailing period, no markdown; specific over generic;
write it in the same language the learner is writing in.`;

export type TitleSuggestResult =
	| { ok: true; title: string }
	| { ok: false; status: 404 | 409 | 503; code: string; error: string };

/** Ask the model for a title for `chatId`. `background` selects the engine's
 *  background flavor (the automatic path) — the learner-initiated path is a
 *  foreground request. */
async function proposeTitle(chatId: string, background: boolean, signal?: AbortSignal): Promise<TitleSuggestResult> {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, code: "not_found", error: "Not found" };
	const digest = transcriptDigest(chat.messages);
	if (!digest) return { ok: false, status: 409, code: "empty_session", error: "This session has no messages to name yet." };
	const spec = resolveRoleSpec("auditor", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 503, code: "models_not_configured", error: "No cheap model configured — set up your models first" };
	if (background && !connectionBackgroundAllowed(spec.provider)) {
		return { ok: false, status: 503, code: "background_not_allowed", error: "Background naming is not enabled for this connection." };
	}
	const prompt = [`Current title: ${chat.title}`, "", digest].join("\n");
	try {
		const out = await runSubmitAgent<{ title: string }>({
			role: "auditor",
			toolName: "submit_title",
			toolDescription: "Submit the one short title for this session.",
			parameters: Type.Object({ title: Type.String({ minLength: 1 }) }),
			fill: (input) => ({ title: typeof input?.title === "string" ? input.title : "" }),
			systemPrompt: INSTRUCTIONS,
			prompt,
			engine: piEngineForSpec(spec, background),
			signal,
			onStep: () => {},
			neverSubmitted: "The model never submitted a title.",
			chatId,
		});
		const title = sanitizeTitle(out.title);
		if (!title) return { ok: false, status: 503, code: "suggest_failed", error: "The model returned an empty title." };
		return { ok: true, title };
	} catch (error) {
		return { ok: false, status: 503, code: "suggest_failed", error: error instanceof Error ? error.message : "Title suggestion failed." };
	}
}

/** Learner-initiated: propose a title; saves nothing. */
export function suggestTitle(chatId: string, signal?: AbortSignal): Promise<TitleSuggestResult> {
	return proposeTitle(chatId, false, signal);
}

/** Chats currently being auto-named — a settled-turn burst must not start two
 *  namers for one chat. */
const inFlight = new Set<string>();

/** Background auto-namer. Resolves true when it renamed the chat. Never
 *  throws: a failure leaves the existing title alone. */
export async function autoTitleChat(chatId: string): Promise<boolean> {
	if (inFlight.has(chatId)) return false;
	const before = stores.chatStore.getChat(chatId);
	if (!before || !autoTitleEligible(before)) return false;
	inFlight.add(chatId);
	try {
		const result = await proposeTitle(chatId, true);
		if (!result.ok) return false;
		// Re-read: the learner may have renamed the session while the model
		// was thinking — a manual (or already-AI) title must win.
		const now = stores.chatStore.getChat(chatId);
		if (!now || !autoTitleEligible(now)) return false;
		stores.chatStore.renameChat(chatId, result.title, "ai");
		return true;
	} catch {
		return false;
	} finally {
		inFlight.delete(chatId);
	}
}
