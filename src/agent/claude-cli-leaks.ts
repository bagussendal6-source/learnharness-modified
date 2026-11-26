/**
 * Claude CLI "leaked tool call" handling. The CLI path flattens history into
 * text, so the model sometimes writes a tool call as plain text
 * (`[assistant called tool quiz …]` + JSON) instead of calling the tool.
 * These helpers (pure) spot those lines, recover the call when its JSON is
 * intact, and let the provider keep them out of the visible message and out
 * of the history it sends back.
 */
import type { JsonObject } from "@earendil-works/pi-ai";

export interface LeakedCall { name: string; arguments: JsonObject }

/** What every leak header starts with — also the holdback set for streaming. */
const STARTS = ["[assistant called tool", "[record: tool call", "[record: tool result", "[tool result for"] as const;
const HEADER = /\[(?:assistant called tool|record: tool call) ([A-Za-z0-9_.:-]+)[^\]\n]*\]|\[(?:tool result for|record: tool result)[^\]\n]*\]/g;

/** The balanced `{…}` object starting at `from` (string/escape aware), or undefined. */
function readJsonObject(text: string, from: number): { value: JsonObject; end: number } | undefined {
	if (text[from] !== "{") return undefined;
	let depth = 0, inString = false, escaped = false;
	for (let i = from; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) {
			try {
				const value = JSON.parse(text.slice(from, i + 1));
				return value && typeof value === "object" && !Array.isArray(value) ? { value: value as JsonObject, end: i + 1 } : undefined;
			} catch { return undefined; }
		}
	}
	return undefined;
}

/** Remove leaked tool-call/result lines from `text`; return what was recovered. */
export function extractLeaks(text: string): { clean: string; calls: LeakedCall[]; leaked: boolean } {
	const calls: LeakedCall[] = [];
	const pieces: string[] = [];
	let at = 0, leaked = false;
	HEADER.lastIndex = 0;
	for (let match = HEADER.exec(text); match; match = HEADER.exec(text)) {
		leaked = true;
		pieces.push(text.slice(at, match.index));
		at = match.index + match[0].length;
		if (match[1] === undefined) { at = text.length; break; } // a made-up tool result: drop it and the rest
		let start = at;
		while (start < text.length && /\s/.test(text[start]!)) start++;
		const json = readJsonObject(text, start);
		if (json) {
			calls.push({ name: match[1], arguments: json.value });
			at = json.end;
			while (at < text.length && /\s/.test(text[at]!)) at++; // the break that followed the removed block
		}
		HEADER.lastIndex = at;
	}
	pieces.push(text.slice(at));
	const joined = pieces.join("");
	return { clean: leaked ? joined.trimEnd() : text, calls, leaked };
}

/** Longest suffix of `text` that could still grow into a header start. */
function heldPrefixLength(text: string): number {
	let hold = 0;
	for (const start of STARTS) {
		for (let k = Math.min(start.length - 1, text.length); k > hold; k--) {
			if (text.endsWith(start.slice(0, k))) { hold = k; break; }
		}
	}
	return hold;
}

/** Streaming filter for one text block: passes normal text through at once,
 *  holds back only a possible marker prefix, and captures a leak to the end. */
export class LeakFilter {
	private pending = "";
	private captured: string | undefined;

	push(delta: string): string {
		if (this.captured !== undefined) { this.captured += delta; return ""; }
		this.pending += delta;
		let first = -1;
		for (const start of STARTS) {
			const i = this.pending.indexOf(start);
			if (i >= 0 && (first < 0 || i < first)) first = i;
		}
		if (first >= 0) {
			const out = this.pending.slice(0, first);
			this.captured = this.pending.slice(first);
			this.pending = "";
			return out;
		}
		const hold = heldPrefixLength(this.pending);
		const out = this.pending.slice(0, this.pending.length - hold);
		this.pending = this.pending.slice(this.pending.length - hold);
		return out;
	}

	/** Block finished: leftover text to show, the calls recovered from a leak. */
	end(): { text: string; calls: LeakedCall[]; leaked: boolean } {
		if (this.captured === undefined) {
			const text = this.pending;
			this.pending = "";
			return { text, calls: [], leaked: false };
		}
		const { clean, calls } = extractLeaks(this.captured);
		return { text: clean, calls, leaked: true };
	}
}
