import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LeakFilter, extractLeaks } from "../src/agent/claude-cli-leaks.ts";

const JSON_ARGS = '{"type":"check","question":"For $f(x)=x^3$, what is {x}?","options":[{"label":"a","value":"a"}],"correctAnswer":"a"}';

describe("extractLeaks", () => {
	it("recovers the call from the real leak seen in a saved session", () => {
		const text = `Read the chart row.\n\n[assistant called tool quiz]\n${JSON_ARGS}`;
		const out = extractLeaks(text);
		assert.equal(out.leaked, true);
		assert.equal(out.clean, "Read the chart row.");
		assert.equal(out.calls.length, 1);
		assert.equal(out.calls[0]!.name, "quiz");
		assert.equal((out.calls[0]!.arguments as { correctAnswer: string }).correctAnswer, "a");
	});
	it("drops a bare marker that carries an invented id and no arguments", () => {
		const out = extractLeaks("Done.\n\n[assistant called tool quiz (id toolu_check_time_rates)]");
		assert.deepEqual({ clean: out.clean, calls: out.calls.length, leaked: out.leaked }, { clean: "Done.", calls: 0, leaked: true });
	});
	it("copes with braces and quotes inside strings, and keeps text after the JSON", () => {
		const out = extractLeaks(`[record: tool call quiz]\n{"q":"a } \\" { b"}\nAfter.`);
		assert.deepEqual(out.calls[0]!.arguments, { q: 'a } " { b' });
		assert.equal(out.clean, "After.");
	});
	it("drops an invented tool result and everything after it", () => {
		const out = extractLeaks("Here.\n[record: tool result quiz]\nfake answer");
		assert.deepEqual({ clean: out.clean, calls: out.calls.length }, { clean: "Here.", calls: 0 });
	});
	it("ignores truncated JSON and ordinary text", () => {
		assert.equal(extractLeaks('[assistant called tool quiz]\n{"q":"cut off').calls.length, 0);
		const plain = "Use [1] and [2]; the [assistant of the year] won.";
		assert.deepEqual(extractLeaks(plain), { clean: plain, calls: [], leaked: false });
	});
});

describe("LeakFilter", () => {
	function run(chunks: string[]) {
		const filter = new LeakFilter();
		let shown = "";
		for (const chunk of chunks) shown += filter.push(chunk);
		return { shown, ...filter.end() };
	}
	it("streams normal text straight through", () => {
		assert.deepEqual(run(["hel", "lo ", "world"]), { shown: "hello world", text: "", calls: [], leaked: false });
	});
	it("holds only a possible marker prefix, then releases it if it was not one", () => {
		const out = run(["a [assist", "ant of the year]"]);
		assert.equal(out.shown + out.text, "a [assistant of the year]");
		assert.equal(out.leaked, false);
	});
	it("captures a leak split anywhere across chunks", () => {
		const text = `Intro.\n\n[assistant called tool quiz]\n${JSON_ARGS}`;
		for (let cut = 1; cut < text.length; cut += 7) {
			const out = run([text.slice(0, cut), text.slice(cut)]);
			assert.equal((out.shown + out.text).trimEnd(), "Intro.", `cut at ${cut}`);
			assert.equal(out.calls.length, 1, `cut at ${cut}`);
		}
	});
});
