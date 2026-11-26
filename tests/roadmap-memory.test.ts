/**
 * Roadmap memory: the 80% mastery rule, which earlier units are worth
 * carrying into a new unit's chat, the teacher's brief, and the progress store
 * (one writer, merge-patch, newer-format refusal).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-memory-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { MASTERY_THRESHOLD, masteryVerdict, relatedMemories, roadmapBrief } = await import("../src/core/roadmap-memory.ts");
const { roadmapStore } = await import("../src/store/roadmap.ts");

test.after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const t = (id: string, prereqs: string[] = [], extra: object = {}) => ({ id, title: `Unit ${id}`, prereqs, ...extra });
const roadmap = {
	version: 1,
	topics: [
		t("E01"),
		t("E02", ["E01"]),
		t("E03", ["E02"]),
		t("E04", ["E03", "E02"], { stage: "A", flags: ["MATH"], chapters: "Supply and Demand", own: "Curves and equilibrium.", checkpoint: ["Solve for equilibrium.", "Shift a curve."], anchor: { book: "mankiw", start: 97, end: 122 } }),
		t("X01"),
		t("X02", ["X01"]),
	],
};
const at = "2026-01-01T00:00:00.000Z";
const progress = (topics: Record<string, object>) => ({ version: 1, topics: Object.fromEntries(Object.entries(topics).map(([k, v]) => [k, { status: "mastered", updatedAt: at, ...v }])) }) as never;
const cite = (r: { book: string; start: number; end: number }) => `${r.book} p. ${r.start - 36}–${r.end - 36} (PDF ${r.start}–${r.end})`;

test("masteryVerdict: 80% passes, just under does not, no scores means no verdict", () => {
	assert.equal(MASTERY_THRESHOLD, 0.8);
	assert.deepEqual(masteryVerdict([1, 0.8, 0.6]), { status: "mastered", percent: 80 });
	assert.deepEqual(masteryVerdict([0.8, 0.8]), { status: "mastered", percent: 80 });
	assert.deepEqual(masteryVerdict([0.79, 0.8]), { status: "shaky", percent: 79 }, "compares the exact mean (79.5%); never displayed as 80%");
	assert.deepEqual(masteryVerdict([1, 0.5]), { status: "shaky", percent: 75 });
	assert.equal(masteryVerdict([]), null);
	assert.deepEqual(masteryVerdict([5, -3, Number.NaN]), { status: "shaky", percent: 50 }, "scores are clamped to 0–1; junk is ignored");
});

test("relatedMemories: only units the new one builds on, only if worth carrying, most useful first", () => {
	const p = progress({
		E01: { struggle: { level: "smooth", summary: "easy" }, attempts: 1 }, // smooth + nothing open → omitted
		E02: { struggle: { level: "hard", summary: "struggled with ceteris paribus" }, attempts: 3, misconceptions: [{ believed: "a shift is a movement", correct: "a shift moves the whole curve", resolved: false }, { believed: "x", correct: "y", resolved: true }] },
		E03: { struggle: { level: "some", summary: "slow on opportunity cost" }, attempts: 1 },
		X01: { struggle: { level: "hard", summary: "unrelated" }, misconceptions: [{ believed: "q", correct: "r", resolved: false }] },
	});
	const memories = relatedMemories(roadmap, p, "E04");
	assert.deepEqual(memories.map((m) => m.unitId), ["E02", "E03"], "E01 went smoothly; X01 is not a prerequisite");
	assert.equal(memories[0]!.distance, 1, "E02 is a direct prerequisite of E04 even though E03 also reaches it");
	assert.deepEqual(memories[0]!.misconceptions.map((m) => m.resolved), [false, true], "unresolved first");
	assert.equal(relatedMemories(roadmap, p, "E01").length, 0);
	assert.deepEqual(relatedMemories(roadmap, p, "nope"), []);
});

test("relatedMemories: depth, caps, and shaky/attempt triggers", () => {
	const p = progress({ E01: { status: "shaky" }, E02: { attempts: 2 }, E03: {} });
	assert.deepEqual(relatedMemories(roadmap, p, "E04").map((m) => m.unitId).sort(), ["E01", "E02"], "shaky and 2+ attempts are carried; E03 is clean");
	assert.deepEqual(relatedMemories(roadmap, p, "E04", { maxDepth: 1 }).map((m) => m.unitId), ["E02"], "E01 is two steps back");
	assert.equal(relatedMemories(roadmap, p, "E04", { maxUnits: 1 }).length, 1);
	const many = progress({ E02: { misconceptions: Array.from({ length: 9 }, (_, i) => ({ believed: `b${i}`, correct: `c${i}`, resolved: false })) } });
	assert.equal(relatedMemories(roadmap, many, "E04")[0]!.misconceptions.length, 4);
});

test("roadmapBrief: the unit, its pages, checkpoint, and memory — and nothing it shouldn't say", () => {
	const p = progress({
		E01: {},
		E02: { struggle: { level: "hard", summary: "kept confusing shifts with movements" }, attempts: 3, misconceptions: [{ believed: "a shift is a movement along the curve", correct: "a shift moves the whole curve", resolved: false }] },
		E03: { status: "learning" },
		X02: { status: "shaky" },
	});
	const brief = roadmapBrief({ roadmap, progress: p, topicId: "E04", cite })!;
	assert.match(brief.text, /Progress: 2 of 6 units mastered, 1 shaky, 1 in progress\./);
	assert.match(brief.text, /Unit to teach now: E04 — Unit E04 \(stage A\) \[MATH\]\./);
	assert.match(brief.text, /Book pages for this unit: mankiw p\. 61–86 \(PDF 97–122\)\. Teach from these pages only/);
	assert.match(brief.text, /Builds on: E03 \(learning\), E02 \(mastered\)\./);
	assert.match(brief.text, /Checkpoint[\s\S]*- Solve for equilibrium\.[\s\S]*- Shift a curve\./);
	assert.match(brief.text, /E02 Unit E02 \(direct prerequisite; mastered, 3 attempts\): a hard unit — kept confusing shifts with movements/);
	assert.match(brief.text, /STILL OPEN: believed "a shift is a movement along the curve" — actually: a shift moves the whole curve/);
	assert.match(brief.text, /Other units still shaky.*X02 Unit X02/);
	assert.ok(!brief.text.includes("E01 Unit E01"), "a clean unit is not recited");
	assert.deepEqual(brief.details.unit.pages, ["mankiw p. 61–86 (PDF 97–122)"]);
	assert.equal(brief.details.resuming, false);
	assert.equal(brief.details.memories[0]!.unitId, "E02");
	assert.equal(roadmapBrief({ roadmap, progress: p, topicId: "nope", cite }), null);
});

test("roadmapBrief: resuming a unit mentions the attempts and where the learner stopped; clean prerequisites say so", () => {
	const p = progress({ E02: {}, E03: {}, E04: { status: "learning", attempts: 1, lastStop: "finished the shift worked example" } });
	const brief = roadmapBrief({ roadmap, progress: p, topicId: "E04", cite })!;
	assert.match(brief.text, /been in this unit before \(status: learning, 1 checkpoint attempt\)\. Last time they stopped at: finished the shift worked example/);
	assert.match(brief.text, /MEMORY: the units this one builds on went smoothly/);
	assert.equal(brief.details.resuming, true);
	assert.equal(brief.details.lastStop, "finished the shift worked example");
});

test("progress store: empty at first, merge-patches one unit, keeps the rest, never invents mastery", () => {
	const id = "rm_test000001";
	assert.deepEqual(roadmapStore.readProgress(id), { version: 1, topics: {} });
	const first = roadmapStore.updateTopic(id, "E02", { status: "learning", chatId: "chat_a", lastStop: "p. 5" });
	assert.equal(first.status, "learning");
	const second = roadmapStore.updateTopic(id, "E02", { attempts: 2, struggle: { level: "hard", summary: "slow" } });
	assert.equal(second.status, "learning", "a patch keeps the fields it doesn't mention");
	assert.equal(second.chatId, "chat_a");
	assert.equal(second.attempts, 2);
	roadmapStore.updateTopic(id, "E03", {});
	const doc = roadmapStore.readProgress(id);
	assert.deepEqual(Object.keys(doc.topics).sort(), ["E02", "E03"]);
	assert.equal(doc.topics.E03!.status, "not_started");
	assert.throws(() => roadmapStore.updateTopic(id, "  ", {}), /Topic id is required/);
	assert.throws(() => roadmapStore.updateTopic("../escape", "E01", {}), /Invalid roadmap folder id/);
});

test("progress store: a file from a newer version is read as empty and never overwritten", () => {
	const id = "rm_future0001";
	const dir = path.join(TMP_DATA, "roadmaps", id);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "progress.json");
	fs.writeFileSync(file, JSON.stringify({ version: 99, topics: { E01: { status: "mastered", updatedAt: at } } }));
	assert.deepEqual(roadmapStore.readProgress(id), { version: 1, topics: {} });
	assert.throws(() => roadmapStore.updateTopic(id, "E01", { status: "learning" }), /newer version/);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).version, 99);
});
