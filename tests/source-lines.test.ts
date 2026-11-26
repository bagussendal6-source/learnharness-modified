import assert from "node:assert/strict";
import { test } from "node:test";
import { joinSources, shortName, sourceName, splitSources } from "../components/source-lines.ts";

const file = { path: "/data/sources/ab12cd34-ujian 2024.pdf", name: "ujian 2024.pdf" };

test("sourceName drops the upload prefix only", () => {
	assert.equal(sourceName("/x/ab12cd34-ujian 2024.pdf"), "ujian 2024.pdf");
	assert.equal(sourceName("/x/notes-final.pdf"), "notes-final.pdf");
	assert.equal(sourceName("/x/ab12cd34-Kuliah 5.pptx.pdf"), "Kuliah 5.pptx");
	assert.equal(sourceName("/x/ab12cd34-old.ppt.pdf"), "old.ppt");
});

test("join/split round-trips text and files", () => {
	for (const text of ["", "Ajari aku bab 3", "line one\nline two", "ends with newline\n"]) {
		const joined = joinSources(text, [file]);
		assert.deepEqual(splitSources(joined), { text, files: [file] });
	}
	assert.equal(joinSources("plain", []), "plain");
	assert.deepEqual(splitSources("plain"), { text: "plain", files: [] });
});

test("several files keep order; removing one leaves the rest", () => {
	const second = { path: "/data/sources/ff00ff00-b.md", name: "b.md" };
	const joined = joinSources("hi", [file, second]);
	assert.deepEqual(splitSources(joined).files, [file, second]);
	assert.equal(splitSources(joinSources("hi", [second])).files.length, 1);
});

test("a message merely mentioning the phrase is not parsed as a file", () => {
	const text = "Tolong baca Source file: di bab 2";
	assert.deepEqual(splitSources(text), { text, files: [] });
});

test("text typed after the block (dictation) lands on its own line", () => {
	const joined = joinSources("a", [file]) + "dictated";
	assert.deepEqual(splitSources(joined), { text: "a\ndictated", files: [file] });
});

test("shortName elides the middle past the limit", () => {
	assert.equal(shortName("short.pdf"), "short.pdf");
	const out = shortName("very-long-lecture-notes-for-the-final-exam-2024.pdf");
	assert(out.length <= 30 && out.includes("…") && out.endsWith("2024.pdf"));
});
