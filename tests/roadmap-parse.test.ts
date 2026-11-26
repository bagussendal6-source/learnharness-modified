/**
 * The roadmap reader: unit blocks → topics, with every format quirk the real
 * roadmap has (wrapped lines, several page spans, flags, gates, running
 * headers, the side-tracks cutoff) and an honest failure for anything else.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { bookKeyOf, parseRoadmapText } from "../src/core/roadmap-parse.ts";

const SAMPLE = `
=== PAGE 1 ===
Economics Roadmap · Mankiw · Hull 1
Economics Roadmap
Intro text that is not a unit.
=== PAGE 2 ===
Economics Roadmap · Mankiw · Hull 2
Stage A · Micro foundations
Mankiw Ch 1–2 · 2 units
How markets work.
E01 Ten principles
Mankiw Ch 1 · PDF pp. 37–52
Chapters: Ten Principles of Economics · Needs: nothing (start here)
Own: Trade-offs, opportunity cost.
Checkpoint (no notes):
☐ Explain opportunity cost with a decision from
your own life.
☐ Give a policy that backfired.
E02 Elasticity MATH · DEEP
Mankiw Ch 5 · PDF pp. 123–144 | Mankiw Ch 6 · PDF pp. 145–160
Chapters: Elasticity and Its Application, Supply, Demand, and
Government Policies · Needs:
E01
Own: Price, income and cross elasticity.
Checkpoint (no notes):
☐ Compute a price elasticity.
GATE A: pass all of these, mixed and without notes
☐ Draw a tariff diagram.
☐ Explain a price floor.
=== PAGE 3 ===
Economics Roadmap · Mankiw · Hull 3
Stage B · Derivatives and quantitative
finance
Hull Ch 1–37 · 1 units
The most mathematical stage.
Q15 Advanced models (optional) MATH · OPTIONAL
Hull Ch 26 · PDF pp. 622–647; Ch 28–34 · PDF pp. 678–797
Chapters: Exotic Options, Martingales · Needs: E02, E01
Own: Exotic options.
Checkpoint (no notes):
☐ Explain change of numeraire.
Side tracks: what the books can't teach
☐ E01 Ten principles ☐ Q15 Advanced models
`;

test("bookKeyOf: short, stable handles", () => {
	assert.equal(bookKeyOf("Mankiw"), "mankiw");
	assert.equal(bookKeyOf("Berk & DeMarzo"), "berk-demarzo");
});

test("parses stages, units, flags, pages, needs, own, checkpoints and gates", () => {
	const { roadmap, bookLabels, problems } = parseRoadmapText(SAMPLE);
	assert.deepEqual(problems, []);
	assert.deepEqual(bookLabels, ["Mankiw", "Hull"]);
	assert.deepEqual(roadmap.topics.map((t) => t.id), ["E01", "E02", "Q15"]);
	assert.deepEqual(roadmap.stages?.map((s) => [s.id, s.title, s.gate.length]), [["A", "Micro foundations", 2], ["B", "Derivatives and quantitative finance", 0]]);

	const e01 = roadmap.topics[0]!;
	assert.equal(e01.title, "Ten principles");
	assert.deepEqual(e01.prereqs, []);
	assert.deepEqual(e01.anchor, { book: "mankiw", start: 37, end: 52 });
	assert.equal(e01.chapters, "Ten Principles of Economics");
	assert.equal(e01.stage, "A");
	assert.deepEqual(e01.checkpoint, ["Explain opportunity cost with a decision from your own life.", "Give a policy that backfired."]);
});

test("wrapped chapter lines, Needs on the next line, several spans and flags", () => {
	const { roadmap } = parseRoadmapText(SAMPLE);
	const e02 = roadmap.topics[1]!;
	assert.deepEqual(e02.flags, ["MATH", "DEEP"]);
	assert.equal(e02.title, "Elasticity");
	assert.deepEqual(e02.prereqs, ["E01"]);
	assert.equal(e02.chapters, "Elasticity and Its Application, Supply, Demand, and Government Policies");
	assert.deepEqual(e02.anchor, { book: "mankiw", start: 123, end: 144 });
	assert.deepEqual(e02.seeAlso, [{ book: "mankiw", start: 145, end: 160 }]);
});

test("a later span may omit the book (';' separated) and keeps the book before it", () => {
	const q15 = parseRoadmapText(SAMPLE).roadmap.topics[2]!;
	assert.deepEqual(q15.flags, ["MATH", "OPTIONAL"]);
	assert.deepEqual(q15.anchor, { book: "hull", start: 622, end: 647 });
	assert.deepEqual(q15.seeAlso, [{ book: "hull", start: 678, end: 797 }]);
	assert.deepEqual(q15.prereqs, ["E02", "E01"]);
});

test("reading stops at the side tracks: the progress tracker's ☐ lines are not checkpoints", () => {
	const q15 = parseRoadmapText(SAMPLE).roadmap.topics[2]!;
	assert.deepEqual(q15.checkpoint, ["Explain change of numeraire."]);
});

test("problems are reported, never guessed: bad prerequisite, missing pages, backwards pages", () => {
	const broken = SAMPLE.replace("Needs: E02, E01", "Needs: E99, soon").replace("Mankiw Ch 1 · PDF pp. 37–52", "Mankiw Ch 1 · PDF pp. 60–52");
	const { problems } = parseRoadmapText(broken);
	assert.ok(problems.some((p) => /"E99", which is not in the roadmap/.test(p)));
	assert.ok(problems.some((p) => /could not read the prerequisite "soon"/.test(p)));
	assert.ok(problems.some((p) => /run backwards/.test(p)));
	const noPages = parseRoadmapText(SAMPLE.replace("Mankiw Ch 1 · PDF pp. 37–52\n", ""));
	assert.ok(noPages.problems.some((p) => /Unit E01 has no "PDF pp\." line/.test(p)));
});

test("a roadmap in another shape yields no topics and says why", () => {
	const { roadmap, problems } = parseRoadmapText("# My plan\n- Week 1: read chapter 1\n- Week 2: read chapter 2\n");
	assert.equal(roadmap.topics.length, 0);
	assert.match(problems.join(" "), /No units were found/);
});

test("a dependency loop is named", () => {
	const looped = SAMPLE.replace("Needs: nothing (start here)", "Needs: E02");
	assert.match(parseRoadmapText(looped).problems.join(" "), /form a loop through: E01, E02/);
});
