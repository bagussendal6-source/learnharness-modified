import { Type } from "typebox";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import { userFacingTextOf } from "../core/native-messages.ts";
import { normalizeTags, MAX_TAGS } from "../core/organize.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { stores } from "./stores.ts";

/**
 * AI tag suggestions: one small submit-agent call on the cheap tier ("auditor"
 * role — same slot extraction uses) reads the session's title + opening
 * exchange and proposes 2–5 topic tags. It only SUGGESTS: nothing is saved
 * until the learner accepts (PUT /api/chats/:id). Reads the transcript only —
 * never the knowledge graph. Usage is not added to the session's cost log.
 */

const DIGEST_CHARS = 3500;

const INSTRUCTIONS = `You label study sessions with short topic tags.
Given a session title and the start of its transcript, call submit_tags with 2-5 tags that name the MATERIAL covered
(e.g. "integral", "teorema-green", "eigenvalue"), not the activity ("chat", "question").
Rules: lowercase, one to three words joined by "-", specific over generic.
When an existing tag already fits, reuse it exactly instead of inventing a near-synonym.`;

export type TagSuggestResult =
	| { ok: true; tags: string[] }
	| { ok: false; status: 404 | 503; code: string; error: string };

function digestOf(chatId: string): { title: string; text: string } | null {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return null;
	const lines: string[] = [];
	let used = 0;
	for (const message of chat.messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = userFacingTextOf((message as { content?: unknown }).content).join("\n").trim();
		if (!text) continue;
		const line = `${message.role === "user" ? "Learner" : "Teacher"}: ${text}`.slice(0, 900);
		lines.push(line);
		used += line.length;
		if (used >= DIGEST_CHARS) break;
	}
	return { title: chat.title, text: lines.join("\n\n") };
}

export async function suggestTags(chatId: string, signal?: AbortSignal): Promise<TagSuggestResult> {
	const digest = digestOf(chatId);
	if (!digest) return { ok: false, status: 404, code: "not_found", error: "Not found" };
	const spec = resolveRoleSpec("auditor", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, status: 503, code: "models_not_configured", error: "No cheap model configured — set up your models first" };
	const existing = [...new Set(stores.chatStore.listChats().flatMap((c) => c.tags ?? []))].slice(0, 60);
	const prompt = [
		`Session title: ${digest.title}`,
		existing.length ? `Existing tags: ${existing.join(", ")}` : "Existing tags: (none yet)",
		"",
		digest.text || "(no messages yet — judge from the title)",
	].join("\n");
	try {
		const out = await runSubmitAgent<{ tags: string[] }>({
			role: "auditor",
			toolName: "submit_tags",
			toolDescription: "Submit the 2-5 topic tags for this session.",
			parameters: Type.Object({ tags: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_TAGS }) }),
			fill: (input) => ({ tags: Array.isArray(input?.tags) ? input.tags : [] }),
			systemPrompt: INSTRUCTIONS,
			prompt,
			engine: piEngineForSpec(spec, false),
			signal,
			onStep: () => {},
			neverSubmitted: "The model never submitted tags.",
			chatId,
		});
		return { ok: true, tags: normalizeTags(out.tags).slice(0, 5) };
	} catch (error) {
		return { ok: false, status: 503, code: "suggest_failed", error: error instanceof Error ? error.message : "Tag suggestion failed." };
	}
}
