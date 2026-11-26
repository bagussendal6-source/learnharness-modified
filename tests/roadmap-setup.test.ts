/**
 * Roadmap setup: import (read exactly, or refuse and save nothing), matching
 * the roadmap's books to added files in either order, the page-range check
 * against a book's own outline, and approval (blocked until it is safe).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-setup-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { checkCounts, verifyRoadmap } = await import("../src/core/roadmap-verify.ts");
const { createFolder } = await import("../src/server/library.ts");
const { makeRoadmapFolder } = await import("../src/server/roadmap.ts");
const { addBook, addUploadedBook } = await import("../src/server/books.ts");
const { approveRoadmap, importRoadmapFile, importRoadmapText, roadmapSetupView } = await import("../src/server/roadmap-setup.ts");
const { libraryStore } = await import("../src/store/library.ts");
const { roadmapStore } = await import("../src/store/roadmap.ts");

test.after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const ROADMAP = `
=== PAGE 1 ===
Roadmap · Sample 1
Stage A · Basics
Sample Ch 1–2 · 2 units
Start here.
S01 First
Sample Ch 1 · PDF pp. 1–2
Chapters: One · Needs: nothing (start here)
Own: Things.
Checkpoint (no notes):
☐ Explain things.
S02 Second MATH
Sample Ch 2 · PDF pp. 3–3
Chapters: Two · Needs: S01
Own: More things.
Checkpoint (no notes):
☐ Explain more.
GATE A: pass all of these
☐ Everything.
`;

createFolder("Ekonomi");
makeRoadmapFolder("Ekonomi");
const folderId = () => libraryStore.getFolderMeta("Ekonomi")!.id;

test("verifyRoadmap: a range on chapter edges is ok; mid-chapter is a warning; outside or missing book is an error", () => {
	const roadmap = {
		version: 1,
		books: [{ label: "Hull", key: "hull" }],
		topics: [
			{ id: "a", title: "A", prereqs: [], anchor: { book: "hull", start: 75, end: 102 } },
			{ id: "b", title: "B", prereqs: [], anchor: { book: "hull", start: 80, end: 102 } },
			{ id: "c", title: "C", prereqs: [], anchor: { book: "hull", start: 800, end: 900 } },
			{ id: "d", title: "D", prereqs: [], anchor: { book: "nope", start: 1, end: 2 } },
			{ id: "e", title: "E", prereqs: [] },
		],
	};
	const book = { pages: 894, outline: [{ depth: 1, startPage: 75, endPage: 102 }, { depth: 1, startPage: 103, endPage: 160 }] };
	const checks = verifyRoadmap(roadmap, (key) => (key === "hull" ? book : null));
	assert.deepEqual(checks.map((c) => c.level), ["ok", "warn", "error", "pending", "error"]);
	assert.match(checks[1]!.notes[0]!, /page 80 is not where a chapter or part starts/);
	assert.match(checks[2]!.notes[0]!, /outside the book/);
	assert.match(checks[3]!.notes[0]!, /the book isn't added yet/);
	assert.deepEqual(checkCounts(checks), { ok: 1, pending: 1, warn: 1, error: 2 });
	// a book with no outline can't be boundary-checked: in-range pages pass
	assert.equal(verifyRoadmap(roadmap, () => ({ pages: 894, outline: [] }))[1]!.level, "ok");
});

test("an unreadable roadmap is refused with its problems and NOTHING is saved", () => {
	const bad = importRoadmapText("Ekonomi", ROADMAP.replace("Needs: S01", "Needs: S99"));
	assert.equal(bad.ok, false);
	if (!bad.ok) {
		assert.equal(bad.status, 422);
		assert.match(bad.problems!.join(" "), /"S99", which is not in the roadmap/);
	}
	assert.equal(roadmapStore.readRoadmap(folderId()), null);
	const other = importRoadmapText("Ekonomi", "# a weekly plan\n- week 1: read");
	assert.ok(!other.ok && /No units were found/.test(other.problems!.join(" ")));
	assert.equal(importRoadmapText("Ekonomi", "  ").ok, false);
});

test("import saves the roadmap as 'proposed'; the setup view says what is missing", () => {
	const done = importRoadmapText("Ekonomi", ROADMAP);
	assert.ok(done.ok && done.units === 2 && done.stages === 1);
	const saved = roadmapStore.readRoadmap(folderId())!;
	assert.deepEqual(saved.topics.map((t) => [t.id, t.mapping]), [["S01", "proposed"], ["S02", "proposed"]]);
	assert.deepEqual(saved.books, [{ label: "Sample", key: "sample" }]);
	const view = roadmapSetupView("Ekonomi");
	assert.ok(view.ok);
	assert.equal(view.setup.state, "setup");
	assert.equal(view.setup.canApprove, false);
	assert.deepEqual(view.setup.blockers, ['Add the book "Sample".'], "a missing book is one blocker, not an error on every unit");
	assert.deepEqual(view.setup.counts, { ok: 0, pending: 2, warn: 0, error: 0 });
	assert.equal(view.setup.roadmap?.units, 2);
	assert.deepEqual(view.setup.books[0], { label: "Sample", key: "sample", file: null, pages: null, ambiguous: false });
	// approval is refused while blocked
	const refused = approveRoadmap("Ekonomi");
	assert.ok(!refused.ok && refused.status === 409 && refused.code === "blocked");
});

test("adding the book afterwards matches it to the roadmap's label and gives it its key", async () => {
	const added = await addBook("Ekonomi", FIXTURE);
	assert.ok(added.ok);
	assert.equal(added.book.key, "sample", "the key is assigned when the book arrives");
	const view = roadmapSetupView("Ekonomi");
	assert.ok(view.ok);
	assert.equal(view.setup.books[0]!.file, "sample-3page.pdf");
	assert.equal(view.setup.books[0]!.pages, 3);
	assert.deepEqual(view.setup.counts, { ok: 2, pending: 0, warn: 0, error: 0 });
	assert.equal(view.setup.canApprove, true);
	assert.deepEqual(view.setup.blockers, []);
	const stage = view.setup.roadmap!.stages[0]!;
	assert.deepEqual([stage.id, stage.title, stage.gate, stage.units.map((u) => u.id)], ["A", "Basics", 1, ["S01", "S02"]]);
	assert.equal(stage.units[0]!.pages, "Sample PDF pp. 1–2");
	assert.deepEqual(stage.units[1]!.flags, ["MATH"]);
});

test("approve: topics become approved and the folder becomes active; re-import goes back to setup", () => {
	const done = approveRoadmap("Ekonomi");
	assert.ok(done.ok && done.units === 2);
	assert.equal(roadmapStore.readMeta(folderId())!.state, "active");
	assert.ok(roadmapStore.readRoadmap(folderId())!.topics.every((t) => t.mapping === "approved"));
	const again = importRoadmapText("Ekonomi", ROADMAP);
	assert.ok(again.ok);
	assert.equal(roadmapStore.readMeta(folderId())!.state, "setup");
	assert.ok(roadmapStore.readRoadmap(folderId())!.topics.every((t) => t.mapping === "proposed"));
});

test("a file import reads .md/.txt; other types are refused", async () => {
	const md = await importRoadmapFile("Ekonomi", "plan.md", new TextEncoder().encode(ROADMAP));
	assert.ok(md.ok && md.units === 2);
	const bad = await importRoadmapFile("Ekonomi", "plan.docx", new TextEncoder().encode("x"));
	assert.ok(!bad.ok && bad.code === "bad_type");
	const empty = await importRoadmapFile("Ekonomi", "plan.md", new Uint8Array());
	assert.ok(!empty.ok && empty.code === "empty");
});

test("an uploaded book streams in under its own name; the same bytes again are a no-op", async () => {
	// different bytes from the already-added fixture (a trailing newline keeps the PDF valid)
	const bytes = Buffer.concat([fs.readFileSync(FIXTURE), Buffer.from("\n")]);
	const stream = () => new Blob([bytes]).stream() as ReadableStream<Uint8Array>;
	const first = await addUploadedBook("Ekonomi", "Another Book.pdf", stream());
	assert.ok(first.ok && !first.existed);
	assert.equal(first.book.sourceName, "Another Book.pdf");
	const again = await addUploadedBook("Ekonomi", "Renamed.pdf", stream());
	assert.ok(again.ok && again.existed, "same content (SHA-256) is the same book");
	const notPdf = await addUploadedBook("Ekonomi", "x.txt", stream());
	assert.ok(!notPdf.ok && notPdf.code === "not_pdf");
	const view = roadmapSetupView("Ekonomi");
	assert.ok(view.ok);
	// the label "Sample" now fits only sample-3page.pdf; the other added book is listed as not in the roadmap
	assert.deepEqual(view.setup.otherBooks.map((b) => b.file), ["Another Book.pdf"]);
});
