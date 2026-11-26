/**
 * Claude CLI provider: offline. A fake `claude` executable (LH_CLAUDE_CLI)
 * replays canned stream-json, so no login, network or real CLI is involved.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { normalizeContext, type Context, type Model, type Api } from "@earendil-works/pi-ai";

const dir = mkdtempSync(path.join(tmpdir(), "lh-fake-claude-"));
const fake = path.join(dir, "claude");
// Behaviour is picked by the prompt: "TOOL" → tool call, "FAIL" → CLI error, else text.
writeFileSync(fake, `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
	const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
	const ev = (event) => out({ type: "stream_event", event, parent_tool_use_id: null });
	if (input.includes("FAIL")) { out({ type: "result", is_error: true, result: "boom" }); process.exit(1); }
	ev({ type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } });
	const text = (index, parts) => {
		ev({ type: "content_block_start", index, content_block: { type: "text" } });
		for (const t of parts) ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
		ev({ type: "content_block_stop", index });
	};
	if (input.includes("LEAKDUP")) {
		text(0, ["ok\\n\\n[assistant called tool lo", "okup (id toolu_x)]"]);
		ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_real", name: "mcp__lh__lookup" } });
		ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"real"}' } });
		ev({ type: "content_block_stop", index: 1 });
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } });
	} else if (input.includes("LEAKJSON")) {
		text(0, ["Intro.\\n\\n[assistant ca", 'lled tool lookup]\\n{"q":', '"oslo"}']);
		ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
	} else if (input.includes("BRACKET")) {
		text(0, ["see [1] and [assis", "tant of the year]"]);
		ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } });
	} else if (input.includes("TOOL")) {
		ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__lh__lookup" } });
		ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } });
		ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"oslo"}' } });
		ev({ type: "content_block_stop", index: 0 });
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } });
	} else {
		ev({ type: "content_block_start", index: 0, content_block: { type: "text" } });
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } });
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } });
		ev({ type: "content_block_stop", index: 0 });
		ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
	}
	ev({ type: "message_stop" });
	setInterval(() => {}, 1000); // like the real CLI, linger until killed
});
`);
chmodSync(fake, 0o755);
process.env.LH_CLAUDE_CLI = fake;
after(() => rmSync(dir, { recursive: true, force: true }));

const { claudeCliProvider, claudeCliRequest, claudeCliAvailable } = await import("../src/agent/claude-cli.ts");

const lookup = { name: "lookup", description: "Look something up", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } };
function ctx(text: string): Context {
	return { systemPrompt: "Be terse.", tools: [lookup] as never, messages: [{ role: "user", content: text, timestamp: 1 }] };
}
const provider = claudeCliProvider();
const model = provider.getModels().find((m) => m.id === "claude-haiku-5-5") as Model<Api>;

describe("claude-cli provider", () => {
	it("is available and lists the CLI models", () => {
		assert.equal(claudeCliAvailable(), true);
		assert.deepEqual(provider.getModels().map((m) => m.id).sort(), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
	});

	it("streams text and reports usage", async () => {
		const stream = provider.streamSimple(model, normalizeContext(ctx("hi")));
		const types: string[] = [];
		for await (const e of stream) types.push(e.type);
		const message = await stream.result();
		assert.deepEqual(types, ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		assert.equal(message.stopReason, "stop");
		assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);
		assert.equal(message.usage.output, 3);
		assert.equal(message.usage.totalTokens, 5 + 3 + 2 + 1);
	});

	it("turns a tool_use block into a pi tool call and stops", async () => {
		const stream = provider.streamSimple(model, normalizeContext(ctx("TOOL")));
		const message = await (async () => { for await (const _ of stream) { /* drain */ } return stream.result(); })();
		assert.equal(message.stopReason, "toolUse");
		assert.deepEqual(message.content, [{ type: "toolCall", id: "toolu_1", name: "lookup", arguments: { q: "oslo" } }]);
	});

	it("surfaces CLI failures as error messages", async () => {
		const message = await provider.streamSimple(model, normalizeContext(ctx("FAIL"))).result();
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage ?? "", /boom/);
	});

	it("turns a tool call written as text into a real call and hides the text", async () => {
		const stream = provider.streamSimple(model, normalizeContext(ctx("LEAKJSON")));
		const message = await (async () => { for await (const _ of stream) { /* drain */ } return stream.result(); })();
		assert.equal(message.stopReason, "toolUse");
		assert.deepEqual(message.content[0], { type: "text", text: "Intro." });
		const call = message.content[1] as { type: string; name: string; arguments: unknown };
		assert.equal(call.type, "toolCall");
		assert.equal(call.name, "lookup");
		assert.deepEqual(call.arguments, { q: "oslo" });
	});

	it("drops the leaked marker without doubling the call when a real call exists", async () => {
		const message = await provider.streamSimple(model, normalizeContext(ctx("LEAKDUP"))).result();
		assert.equal(message.stopReason, "toolUse");
		assert.equal(message.content.filter((p) => p.type === "toolCall").length, 1);
		assert.deepEqual(message.content[0], { type: "text", text: "ok" });
		assert.deepEqual(message.content[1], { type: "toolCall", id: "toolu_real", name: "lookup", arguments: { q: "real" } });
	});

	it("leaves ordinary bracketed text alone, even split across chunks", async () => {
		const message = await provider.streamSimple(model, normalizeContext(ctx("BRACKET"))).result();
		assert.equal(message.stopReason, "stop");
		assert.deepEqual(message.content, [{ type: "text", text: "see [1] and [assistant of the year]" }]);
	});

	it("aborts promptly", async () => {
		const controller = new AbortController();
		const stream = provider.streamSimple(model, normalizeContext(ctx("hi")), { signal: controller.signal });
		controller.abort();
		const message = await stream.result();
		assert.equal(message.stopReason, "aborted");
	});
});

describe("claudeCliRequest", () => {
	it("flattens history and keeps tools from system messages", () => {
		const { system, tools, transcript } = claudeCliRequest(normalizeContext({
			systemPrompt: "SYS",
			tools: [lookup] as never,
			messages: [
				{ role: "user", content: "question", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "lookup", arguments: { q: "x" } }], api: "claude-cli", provider: "claude-cli", model: "haiku", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
				{ role: "toolResult", toolCallId: "t1", toolName: "lookup", content: [{ type: "text", text: "answer" }], isError: false, timestamp: 3 },
			],
		}));
		assert.match(system, /SYS/);
		assert.deepEqual(tools.map((t) => t.name), ["lookup"]);
		assert.match(transcript, /\[user\]\nquestion/);
		assert.match(transcript, /\[record: tool call lookup\]\n\{"q":"x"\}/);
		assert.match(transcript, /\[record: tool result lookup\]\nanswer/);
		assert.doesNotMatch(transcript, /assistant called tool/);
	});
});
