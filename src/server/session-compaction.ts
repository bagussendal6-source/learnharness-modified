import { composeInstructions } from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { connectionBackgroundAllowed } from "../agent/subscription-connections.ts";
import { hasProbeDone } from "../core/native-messages.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { compactAtSessionBoundary, effectiveThresholdTokens, type CompactionDeps } from "./compaction.ts";
import { catalogContextLimits } from "./model-catalog.ts";
import { effectiveSettings, stores } from "./stores.ts";

/**
 * Close session → fold the finished session(s) into the compaction summary in
 * the background, so the next session's teacher starts light. The deps are
 * built exactly like the turn-settle kick's (chat-handler): the session's own
 * conversation engine, the background-consent gate, the same threshold and
 * prompt-size estimate. A chat with no usable engine is a silent no-op.
 */
function sessionCompactionDeps(chatId: string): CompactionDeps | null {
	const fresh = effectiveSettings();
	const record = stores.chatStore.getChat(chatId);
	if (!record) return null;
	const spec = resolveConversationSpec(record.settings, fresh.models.strong);
	if (!spec || !connectionBackgroundAllowed(spec.provider)) return null;
	let engine: PiEngine;
	try {
		engine = piEngineForSpec(spec, true);
	} catch {
		return null;
	}
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	return {
		chatStore: stores.chatStore,
		engine,
		canStart: () => connectionBackgroundAllowed(spec.provider),
		modelId,
		kind: record.kind === "practice" ? "practice" : hasProbeDone(record.messages) ? "teach" : "probe",
		thresholdTokens: effectiveThresholdTokens(fresh.compaction?.thresholdTokens, catalogContextLimits().get(modelId)),
		systemPromptTokens: Math.ceil(composeInstructions(record.kind === "practice" ? (record.exam ? "exam" : "practice") : "teacher").length / 4),
	};
}

/** Fire-and-forget. Skipped under tests (the service is pinned directly). */
export function kickSessionCompaction(chatId: string): void {
	if (process.env.NODE_ENV === "test") return;
	const deps = sessionCompactionDeps(chatId);
	if (!deps) return;
	void compactAtSessionBoundary(deps, chatId);
}
