/**
 * Book index logic (pure): outline spans, printed-page detection, garbled-text
 * flag, retrieval caps, BM25 page search, roadmap-label matching.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_PAGES_PER_CALL,
	PageSearchIndex,
	clampRange,
	detectPageOffset,
	isGarbled,
	matchesBookLabel,
	outlineSpans,
	pageCitation,
	printedPage,
	tokenize,
} from "../src/core/book-index.ts";

test("outlineSpans: a span runs to the page before the next entry of the same or shallower depth", () => {
	const spans = outlineSpans(
		[
			{ title: "Part I", page: 10, depth: 0 },
			{ title: "Ch 1", page: 10, depth: 1 },
			{ title: "1.1 Intro", page: 12, depth: 2 },
			{ title: "Ch 2", page: 30, depth: 1 },
			{ title: "Part II", page: 50, depth: 0 },
			{ title: "Broken", page: 0, depth: 1 },
			{ title: "Beyond", page: 999, depth: 1 },
		],
		60,
	);
	const by = Object.fromEntries(spans.map((s) => [s.title, [s.startPage, s.endPage]]));
	assert.deepEqual(by["Part I"], [10, 49]);
	assert.deepEqual(by["Ch 1"], [10, 29]);
	assert.deepEqual(by["1.1 Intro"], [12, 29]);
	assert.deepEqual(by["Ch 2"], [30, 49]);
	assert.deepEqual(by["Part II"], [50, 60]);
	assert.equal(spans.length, 5, "entries pointing at no real page are dropped, never guessed");
});

test("outlineSpans: two siblings on one page — the first covers just that page", () => {
	const spans = outlineSpans([{ title: "A", page: 5, depth: 0 }, { title: "B", page: 5, depth: 0 }], 20);
	assert.deepEqual([spans[0]!.startPage, spans[0]!.endPage], [5, 5]);
	assert.deepEqual([spans[1]!.startPage, spans[1]!.endPage], [5, 20]);
});

function bookPages(n: number, offset: number, glued: boolean): string[] {
	return Array.from({ length: n }, (_, i) => {
		const printed = i + 1 - offset;
		if (printed < 1) return "Front matter roman numerals only";
		return glued ? `part V Firm Behavior and industry${printed} body text here ${"word ".repeat(40)} WCN 02-200-203` : `Header title ${printed} body text ${"word ".repeat(40)}`;
	});
}

test("detectPageOffset: finds the shift, even when the number is glued to a word", () => {
	for (const glued of [false, true]) {
		const result = detectPageOffset(bookPages(300, 36, glued));
		assert.equal(result.offset, 36, `glued=${glued}`);
		assert.ok(result.confidence > 0.8);
	}
});

test("detectPageOffset: no printed numbers (or too short a book) → null, never a guess", () => {
	assert.equal(detectPageOffset(Array.from({ length: 300 }, (_, i) => `Section ${"x ".repeat(60)} ${i % 7 === 0 ? "7" : ""}`)).offset, null);
	assert.equal(detectPageOffset(bookPages(10, 2, false)).offset, null);
});

test("printedPage / pageCitation: labels win, then the offset, front matter is unnumbered", () => {
	assert.equal(printedPage({ labels: ["Cover", "i", "19", "20"], pageOffset: null }, 3), "19");
	assert.equal(printedPage({ labels: ["Cover", "i", "19", "20"], pageOffset: null }, 2), null, "roman front matter is not a printed number");
	assert.equal(printedPage({ labels: null, pageOffset: 26 }, 629), "603");
	assert.equal(printedPage({ labels: null, pageOffset: 26 }, 10), null);
	assert.equal(printedPage({ labels: null, pageOffset: null }, 10), null);
	assert.equal(pageCitation({ labels: null, pageOffset: 26 }, 629), "p. 603 (PDF 629)");
	assert.equal(pageCitation({ labels: null, pageOffset: null }, 10), "PDF 10");
});

test("isGarbled: symbol-font defects trip it, ordinary prose and real math do not", () => {
	assert.equal(isGarbled("where  ¼ r  q þ  2 = 2 y ¼ ln ½ H ð S 0 K Þ  ffiffiffiffi T p þ"), true);
	assert.equal(isGarbled("The market clears where supply equals demand, so P = MC."), false);
	assert.equal(isGarbled("Δ𝑄/𝑄 = 𝜂 𝑑 × (Δ𝑃 + 𝜏)/𝑃 = 𝜂 𝑠 × Δ𝑃/𝑃"), false);
});

test("clampRange: the hard page cap, the book's edges, and reversed input", () => {
	assert.deepEqual(clampRange(37, 52, 854), { start: 37, end: 37 + MAX_PAGES_PER_CALL - 1, clipped: true });
	assert.deepEqual(clampRange(10, 12, 854), { start: 10, end: 12, clipped: false });
	assert.deepEqual(clampRange(12, 10, 854), { start: 10, end: 12, clipped: false });
	assert.deepEqual(clampRange(850, 900, 854), { start: 850, end: 854, clipped: false });
	assert.equal(clampRange(900, 910, 854), null);
	assert.equal(clampRange(1.5, 3, 854), null);
});

test("PageSearchIndex: the page about the terms ranks first; unknown terms find nothing", () => {
	const index = new PageSearchIndex([
		"The cat sat on the mat and looked at the dog.",
		"A deadweight loss is the reduction in total surplus caused by a tax. The deadweight loss grows with elasticity.",
		"Elasticity measures how much quantity demanded responds to price.",
		"Nothing relevant here at all.",
	]);
	const hits = index.search("deadweight loss tax");
	assert.equal(hits[0]!.page, 2);
	assert.match(hits[0]!.snippet, /deadweight loss/i);
	assert.deepEqual(index.search("zymurgy"), []);
	assert.equal(index.search("elasticity").length, 2);
	assert.ok(tokenize("The Black–Scholes–Merton formula").includes("scholes"));
});

test("matchesBookLabel: every word of the roadmap's label must name the file", () => {
	const demarzo = { sourceName: "Corporate Finance [RENTAL EDITION], 5th edition -- Peter M_ DeMarzo; Jonathan B_ Berk -- Pearson.pdf", title: null };
	assert.equal(matchesBookLabel("Berk & DeMarzo", demarzo), true);
	assert.equal(matchesBookLabel("Hull", demarzo), false);
	assert.equal(matchesBookLabel("", demarzo), false);
	assert.equal(matchesBookLabel("Mankiw", { sourceName: "x.pdf", title: "Principles by Mankiw" }), true);
});
