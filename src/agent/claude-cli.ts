import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
	createProvider,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { LeakFilter, extractLeaks, type LeakedCall } from "./claude-cli-leaks.ts";

/**
 * Claude CLI provider: runs each model call through the user's installed
 * `claude` binary (its own login — a Claude subscription), instead of an API
 * key. The CLI is used purely as an LLM: its built-in tools are off, and the
 * app's tools are declared through a stub MCP server so the model can emit
 * tool calls. We stop the CLI after that single assistant message and hand
 * the calls back to pi's agent loop, which executes them as usual.
 *
 * Trade-offs: the transcript is flattened into one prompt (the CLI cannot
 * take structured history), there is no thinking-level control, and prompt
 * caching across calls is whatever the CLI gets for free.
 */

export const CLAUDE_CLI_PROVIDER = "claude-cli";
export const CLAUDE_CLI_API = "claude-cli";
const TOOL_PREFIX = "mcp__lh__";

let cachedBinary: string | null | undefined;

/** The `claude` executable: LH_CLAUDE_CLI, else PATH, else the usual install spots
 *  (a packaged desktop app does not inherit the shell's PATH). */
export function claudeCliBinary(): string | undefined {
	if (cachedBinary !== undefined) return cachedBinary ?? undefined;
	const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
	const dirs = [
		...(process.env.PATH ?? "").split(path.delimiter),
		path.join(homedir(), ".local", "bin"),
		path.join(homedir(), ".claude", "local"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	].filter(Boolean);
	const candidates = [process.env.LH_CLAUDE_CLI, ...dirs.flatMap((dir) => names.map((name) => path.join(dir, name)))];
	cachedBinary = candidates.find((file): file is string => !!file && existsSync(file)) ?? null;
	return cachedBinary ?? undefined;
}
export function claudeCliAvailable(): boolean {
	return claudeCliBinary() !== undefined;
}

let loggedIn: boolean | undefined;
let checkedAt = 0;
/** Record what `claude auth status` last said (the login route calls this after sign-in/out). */
export function setClaudeCliLogin(value: boolean): void {
	loggedIn = value;
	checkedAt = Date.now();
}
/** Installed AND signed in. Sync for the picker: optimistic until the first
 *  background `claude auth status` answers, then refreshed at most every 15 s. */
export function claudeCliConnected(): boolean {
	const binary = claudeCliBinary();
	if (!binary) return false;
	if (Date.now() - checkedAt > 15_000) {
		checkedAt = Date.now();
		execFile(binary, ["auth", "status"], { timeout: 20_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }, (_error, stdout) => {
			try { loggedIn = JSON.parse(String(stdout)).loggedIn === true; } catch { loggedIn = false; }
		});
	}
	return loggedIn !== false;
}

const MODELS: { id: string; name: string }[] = [
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5 (CLI login)" },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (CLI login)" },
	{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5 (CLI login)" },
];

/** Minimal stdio MCP server: lists the app's tools and answers calls with a
 *  placeholder (the CLI is stopped before a result matters). */
const STUB_MCP = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const tools = JSON.parse(require("node:fs").readFileSync(process.env.LH_TOOLS_FILE, "utf8"));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
	let m; try { m = JSON.parse(line); } catch { return; }
	if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lh", version: "1" } } });
	else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
	else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "pending" }] } });
	else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

function emptyUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function emptyMessage(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "pending", timestamp: Date.now(), usage: emptyUsage() };
}

/** System prompt + the tools live at that point (messages add and remove tools). */
export interface CliImage { data: string; mimeType: string }
export function claudeCliRequest(context: TranscriptContext): { system: string; tools: Tool[]; transcript: string; images: CliImage[] } {
	const images: CliImage[] = [];
	// Images ride along as real image blocks; the transcript keeps a numbered marker where each one sat.
	const textOf = (content: string | { type: string; text?: string; data?: string; mimeType?: string }[]): string => {
		if (typeof content === "string") return content;
		return content.map((part) => {
			if (part.type === "text") return part.text ?? "";
			if (part.type === "image" && part.data) { images.push({ data: part.data, mimeType: part.mimeType ?? "image/png" }); return `[image ${images.length} attached]`; }
			return "";
		}).join("\n");
	};
	const tools = new Map<string, Tool>();
	const system: string[] = [];
	const lines: string[] = [];
	for (const message of context.messages as Message[]) {
		if (message.role === "system") {
			const base = textOf(message.content);
			const sections = Object.values(message.sections ?? {}).filter((s): s is string => !!s);
			const text = [base, ...sections].filter(Boolean).join("\n\n");
			if (text) (system.length === 0 ? system : lines).push(system.length === 0 ? text : `[system]\n${text}`);
			for (const ref of message.toolsRemoved ?? []) tools.delete(ref.name);
			for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
		} else if (message.role === "user") {
			lines.push(`[user]\n${textOf(message.content)}`);
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				// Earlier replies may carry leaked tool-call text; never feed it back.
				const clean = part.type === "text" ? extractLeaks(part.text).clean : "";
				if (part.type === "text" && clean) lines.push(`[assistant]\n${clean}`);
				else if (part.type === "toolCall") lines.push(`[record: tool call ${part.name}]\n${JSON.stringify(part.arguments)}`);
			}
		} else {
			lines.push(`[record: tool result ${message.toolName}${message.isError ? " — ERROR" : ""}]\n${textOf(message.content)}`);
		}
	}
	const transcript = [
		"Below is the conversation so far. Write ONLY the assistant's next turn: reply in plain text and/or call the available tools.",
		"Lines that start with [user], [assistant] or [record: …] are read-only history written by the system. Never write such lines yourself.",
		"Never write a tool call as text. To use a tool, call it through the tool interface; a call written as text does nothing and the learner sees it as garbage.",
		"",
		"<conversation>",
		lines.join("\n\n") || "[user]\n(no messages)",
		"</conversation>",
	].join("\n");
	return { system: system.join("\n\n"), tools: [...tools.values()], transcript, images };
}

function failure(model: Model<Api>, partial: AssistantMessage, message: string, aborted: boolean): AssistantMessage {
	return { ...partial, api: model.api, stopReason: aborted ? "aborted" : "error", errorMessage: message };
}

function claudeCliStream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const output = new AssistantMessageEventStream();
	void run(output, model, context, options);
	return output;
}

async function run(output: AssistantMessageEventStream, model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): Promise<void> {
	let partial = emptyMessage(model);
	let dir: string | undefined;
	let finished = false;
	const finish = (event: Parameters<AssistantMessageEventStream["push"]>[0]) => {
		if (finished) return;
		finished = true;
		output.push(event);
	};
	try {
		const binary = claudeCliBinary();
		if (!binary) throw new Error("The `claude` CLI was not found. Install Claude Code and sign in, or set LH_CLAUDE_CLI to its path.");
		if (options?.signal?.aborted) throw Object.assign(new Error("aborted"), { aborted: true });
		const { system, tools, transcript, images } = claudeCliRequest(context);
		dir = await mkdtemp(path.join(tmpdir(), "lh-claude-"));
		const toolsFile = path.join(dir, "tools.json");
		const mcpFile = path.join(dir, "mcp.json");
		const systemFile = path.join(dir, "system.md");
		await writeFile(toolsFile, JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }))));
		await writeFile(systemFile, system || "You are a helpful assistant.");
		await writeFile(mcpFile, JSON.stringify({ mcpServers: { lh: { command: process.execPath, args: ["-e", STUB_MCP], env: { LH_TOOLS_FILE: toolsFile, ELECTRON_RUN_AS_NODE: "1" } } } }));

		const args = [
			"-p", ...(images.length ? ["--input-format", "stream-json"] : []), "--output-format", "stream-json", "--verbose", "--include-partial-messages",
			"--model", model.id,
			"--system-prompt-file", systemFile,
			"--tools", "",
			"--strict-mcp-config", "--mcp-config", mcpFile,
			"--setting-sources", "project",
			"--no-session-persistence", "--disable-slash-commands",
			"--max-turns", "1",
		];
		if (tools.length) args.push("--allowedTools", `${TOOL_PREFIX}*`);
		const child = spawn(binary, args, {
			cwd: dir,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ELECTRON_RUN_AS_NODE: undefined },
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
		const onAbort = () => child.kill("SIGTERM");
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin.on("error", () => { /* child exited early; surfaced by close */ });
		if (images.length) {
			const content = [{ type: "text", text: transcript }, ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))];
			child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
		} else child.stdin.end(transcript);

		const blocks = new Map<number, { kind: "text" | "thinking" | "tool"; json: string; id?: string; name?: string; filter?: LeakFilter }>();
		const leakedCalls: LeakedCall[] = [];
		const declared = new Set(tools.map((tool) => tool.name));
		let stopReason: string | undefined;
		let resultError: string | undefined;
		let messageDone = false;

		output.push({ type: "start", partial });
		const handle = (event: Record<string, any>) => {
			switch (event.type) {
				case "message_start": {
					const usage = event.message?.usage;
					if (usage) {
						partial.usage.input = usage.input_tokens ?? 0;
						partial.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
						partial.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
					}
					break;
				}
				case "content_block_start": {
					const block = event.content_block ?? {};
					const index = partial.content.length;
					if (block.type === "text") {
						blocks.set(event.index, { kind: "text", json: "", filter: new LeakFilter() });
						partial.content.push({ type: "text", text: "" });
						output.push({ type: "text_start", contentIndex: index, partial });
					} else if (block.type === "thinking") {
						blocks.set(event.index, { kind: "thinking", json: "" });
						partial.content.push({ type: "thinking", thinking: "" });
						output.push({ type: "thinking_start", contentIndex: index, partial });
					} else if (block.type === "tool_use") {
						const name = String(block.name ?? "");
						blocks.set(event.index, { kind: "tool", json: "", id: block.id, name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name });
						partial.content.push({ type: "toolCall", id: String(block.id), name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name, arguments: {} });
						output.push({ type: "toolcall_start", contentIndex: index, partial });
					}
					break;
				}
				case "content_block_delta": {
					const block = blocks.get(event.index);
					if (!block) break;
					const contentIndex = [...blocks.keys()].indexOf(event.index);
					const delta = event.delta ?? {};
					if (block.kind === "text" && delta.type === "text_delta") {
						const shown = block.filter!.push(delta.text);
						if (shown) {
							(partial.content[contentIndex] as { text: string }).text += shown;
							output.push({ type: "text_delta", contentIndex, delta: shown, partial });
						}
					} else if (block.kind === "thinking" && delta.type === "thinking_delta") {
						(partial.content[contentIndex] as { thinking: string }).thinking += delta.thinking;
						output.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial });
					} else if (block.kind === "tool" && delta.type === "input_json_delta") {
						block.json += delta.partial_json ?? "";
						output.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json ?? "", partial });
					}
					break;
				}
				case "content_block_stop": {
					const block = blocks.get(event.index);
					if (!block) break;
					const contentIndex = [...blocks.keys()].indexOf(event.index);
					const part = partial.content[contentIndex];
					if (!part) break;
					if (block.kind === "text" && part.type === "text") {
						const tail = block.filter!.end();
						if (tail.text) {
							part.text += tail.text;
							output.push({ type: "text_delta", contentIndex, delta: tail.text, partial });
						}
						if (tail.leaked) { part.text = part.text.trimEnd(); leakedCalls.push(...tail.calls); }
						output.push({ type: "text_end", contentIndex, content: part.text, partial });
					}
					else if (block.kind === "thinking" && part.type === "thinking") output.push({ type: "thinking_end", contentIndex, content: part.thinking, partial });
					else if (block.kind === "tool" && part.type === "toolCall") {
						try {
							const parsed = block.json.trim() ? JSON.parse(block.json) : {};
							if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments are not a JSON object");
							part.arguments = parsed;
						} catch (error) {
							part.arguments = {};
							part.argumentsError = `${error instanceof Error ? error.message : "invalid arguments"}: ${block.json.slice(0, 500)}`;
						}
						output.push({ type: "toolcall_end", contentIndex, toolCall: part as ToolCall, partial });
					}
					break;
				}
				case "message_delta": {
					stopReason = event.delta?.stop_reason ?? stopReason;
					if (event.usage?.output_tokens !== undefined) partial.usage.output = event.usage.output_tokens;
					break;
				}
				case "message_stop": {
					// A tool call the model wrote as text becomes a real one — but only when it made no real call itself.
					if (!partial.content.some((part) => part.type === "toolCall")) {
						for (const call of leakedCalls) {
							if (!declared.has(call.name)) continue;
							const index = partial.content.length;
							const toolCall: ToolCall = { type: "toolCall", id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`, name: call.name, arguments: {} };
							partial.content.push(toolCall);
							output.push({ type: "toolcall_start", contentIndex: index, partial });
							output.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial });
							toolCall.arguments = call.arguments;
							output.push({ type: "toolcall_end", contentIndex: index, toolCall, partial });
						}
					}
					messageDone = true;
					break;
				}
			}
		};

		const lines = (async function* () {
			let buffer = "";
			for await (const chunk of child.stdout) {
				buffer += (chunk as Buffer).toString();
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) yield line;
				}
			}
			if (buffer.trim()) yield buffer.trim();
		})();
		const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));

		for await (const line of lines) {
			let parsed: Record<string, any>;
			try { parsed = JSON.parse(line); } catch { continue; }
			if (parsed.type === "stream_event" && parsed.event && !parsed.parent_tool_use_id) handle(parsed.event);
			else if (parsed.type === "result" && parsed.is_error) resultError = typeof parsed.result === "string" ? parsed.result : "Claude CLI reported an error";
			if (messageDone) break;
		}
		// One assistant message is all we want; anything after is the CLI running our stub tool.
		child.kill("SIGTERM");
		options?.signal?.removeEventListener("abort", onAbort);
		const code = await closed;
		if (options?.signal?.aborted) throw Object.assign(new Error("aborted"), { aborted: true });

		if (!messageDone) {
			const detail = resultError ?? (stderr.trim() || `claude exited with code ${code}`);
			throw new Error(/login|auth|401|credential/i.test(detail) ? `Claude CLI is not signed in. Run \`claude\` once and log in. (${detail.slice(0, 200)})` : detail.slice(0, 500));
		}
		const hasToolCall = partial.content.some((part) => part.type === "toolCall");
		const reason = hasToolCall ? "toolUse" : stopReason === "max_tokens" ? "length" : "stop";
		partial = { ...partial, stopReason: reason };
		partial.usage.totalTokens = partial.usage.input + partial.usage.output + partial.usage.cacheRead + partial.usage.cacheWrite;
		finish({ type: "done", reason, message: partial });
	} catch (error) {
		const aborted = options?.signal?.aborted === true || (error as { aborted?: boolean })?.aborted === true;
		const message = failure(model, partial, aborted ? "Claude CLI request cancelled." : error instanceof Error ? error.message : "Claude CLI request failed.", aborted);
		finish({ type: "error", reason: aborted ? "aborted" : "error", error: message });
	} finally {
		if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {});
		output.end();
	}
}

/** The provider registered into piModels(). Zero-cost models: the CLI bills the user's plan, not an API key. */
export function claudeCliProvider(): Provider {
	const models: Model<Api>[] = MODELS.map((m) => ({
		id: m.id,
		name: m.name,
		api: CLAUDE_CLI_API,
		provider: CLAUDE_CLI_PROVIDER,
		baseUrl: "",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	}));
	return createProvider({
		id: CLAUDE_CLI_PROVIDER,
		name: "Claude (CLI login)",
		auth: {
			apiKey: {
				name: "Claude CLI login",
				check: async () => (claudeCliConnected() ? { type: "api_key", source: "claude CLI" } : undefined),
				resolve: async () => (claudeCliConnected() ? { auth: { apiKey: "claude-cli" }, source: "claude CLI" } : undefined),
			},
		},
		models,
		api: { stream: claudeCliStream, streamSimple: claudeCliStream },
	});
}
