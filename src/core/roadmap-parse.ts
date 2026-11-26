/**
 * Reads a written roadmap into topics — pure, no model.
 *
 * The format this understands is the "unit block" roadmap: stages, each a list
 * of units shaped like
 *
 *   E04 Supply and demand MATH
 *   Mankiw Ch 4 · PDF pp. 97–122
 *   Chapters: The Market Forces of Supply and Demand · Needs: E03
 *   Own: Demand and supply curves, shifts vs. movements, equilibrium.
 *   Checkpoint (no notes):
 *   ☐ Solve two linear equations for equilibrium.
 *
 * followed by a "GATE A: …" block of ☐ tasks. The text is the line-structured
 * text of the roadmap (pages marked `=== PAGE n ===`, the running header on
 * each page ignored). Anything it can't read is REPORTED in `problems`, never
 * guessed: a roadmap in another shape yields no topics and says so.
 */

import type { PageRange, RoadmapDoc, RoadmapStage, RoadmapTopic } from "./contracts/roadmap.ts";
import { ROADMAP_FORMAT_VERSION } from "./contracts/roadmap.ts";
import { roadmapProblems } from "./roadmap.ts";

const FLAGS = ["DEEP", "MATH", "OPTIONAL"];
const UNIT_HEADER = /^([A-Z]\d{2}) (.+)$/;
const STAGE_HEADER = /^Stage ([A-Z]) · (.+)$/;
const STAGE_SUB = /^.+ Ch [\d–-]+ · \d+ units?$/;
const GATE_HEADER = /^GATE ([A-Z]):/;
// "Hull Ch 26 · PDF pp. 622–647"; a later span may omit the book: "Ch 28–34 · PDF pp. 678–797".
const SOURCE = /^(?:(.+?) )?Ch ([\d–-]+(?:, ?[\d–-]+)*)\s*·\s*PDF pp?\.\s*(\d+)(?:\s*[–-]\s*(\d+))?$/;
const END_OF_UNITS = /^Side tracks/i;

/** Short handle for a book label: "Berk & DeMarzo" → "berk-demarzo". */
export function bookKeyOf(label: string): string {
	return label
		.toLowerCase()
		.replace(/&|\band\b/g, " ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export interface ParsedRoadmap {
	roadmap: RoadmapDoc;
	/** Book labels exactly as the roadmap writes them ("Mankiw", "Berk & DeMarzo"). */
	bookLabels: string[];
	/** Everything unreadable or inconsistent; empty = a clean import. */
	problems: string[];
}

function splitFlags(title: string): { title: string; flags: string[] } {
	const flags: string[] = [];
	let rest = title.trim();
	for (;;) {
		const m = rest.match(/^(.*?)\s*(?:·\s*)?\b(DEEP|MATH|OPTIONAL)\s*$/);
		if (!m || m[1] === "") break;
		flags.unshift(m[2]!);
		rest = m[1]!.replace(/\s*·\s*$/, "").trim();
	}
	return { title: rest, flags: flags.filter((f) => FLAGS.includes(f)) };
}

function cleanLines(text: string): string[] {
	const lines: string[] = [];
	let first = false;
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\s+/g, " ").trim();
		if (/^=== PAGE \d+ ===$/.test(line)) {
			first = true; // the next line is the page's running header
			continue;
		}
		if (first) {
			first = false;
			if (/ \d+$/.test(line) && line.includes(" · ")) continue; // "Roadmap · Mankiw · … 7"
		}
		if (line !== "") lines.push(line);
	}
	return lines;
}

function needsOf(raw: string): { ids: string[]; unknown: string[] } {
	const text = raw.trim();
	if (text === "" || /^nothing/i.test(text)) return { ids: [], unknown: [] };
	const ids = text.match(/[A-Z]\d{2}/g) ?? [];
	const leftover = text.replace(/[A-Z]\d{2}/g, "").replace(/[,\s]+/g, " ").trim();
	return { ids: [...new Set(ids)], unknown: leftover ? [leftover] : [] };
}

export function parseRoadmapText(text: string): ParsedRoadmap {
	const lines = cleanLines(text);
	const topics: RoadmapTopic[] = [];
	const stages: RoadmapStage[] = [];
	const labels: string[] = [];
	const problems: string[] = [];

	let stage: RoadmapStage | null = null;
	let unit: { topic: RoadmapTopic; section: "source" | "chapters" | "own" | "checkpoint"; chapters: string[]; own: string[]; checkpoint: string[] } | null = null;
	let inGate = false;
	let summaryOpen = false;

	const closeUnit = () => {
		if (!unit) return;
		const t = unit.topic;
		const joined = unit.chapters.join(" ").trim();
		const marker = joined.lastIndexOf(" · Needs:");
		const chapterText = (marker >= 0 ? joined.slice(0, marker) : joined).replace(/^Chapters:\s*/, "");
		const needsRaw = marker >= 0 ? joined.slice(marker + " · Needs:".length) : "";
		if (chapterText) t.chapters = chapterText;
		if (marker < 0) problems.push(`Unit ${t.id} has no "Needs:" line.`);
		const needs = needsOf(needsRaw);
		t.prereqs = needs.ids;
		for (const u of needs.unknown) problems.push(`Unit ${t.id}: could not read the prerequisite "${u}".`);
		if (unit.own.length) t.own = unit.own.join(" ").replace(/^Own:\s*/, "").trim();
		t.checkpoint = unit.checkpoint;
		if (t.checkpoint.length === 0) problems.push(`Unit ${t.id} has no checkpoint items.`);
		if (!t.anchor) problems.push(`Unit ${t.id} has no "PDF pp." line, so no pages are known for it.`);
		topics.push(t);
		unit = null;
	};

	const closeStage = () => {
		closeUnit();
		if (stage) stages.push(stage);
		stage = null;
		inGate = false;
		summaryOpen = false;
	};

	for (const line of lines) {
		if (END_OF_UNITS.test(line)) break;

		const stageMatch = line.match(STAGE_HEADER);
		if (stageMatch) {
			closeStage();
			stage = { id: stageMatch[1]!, title: stageMatch[2]!, gate: [] };
			summaryOpen = true;
			continue;
		}
		if (stage && summaryOpen && !unit) {
			if (STAGE_SUB.test(line)) continue;
			if (!UNIT_HEADER.test(line) && !GATE_HEADER.test(line)) {
				// a wrapped stage title ("…quantitative / finance") or the stage summary
				if (stage.summary === undefined && /^[a-z]/.test(line) && stage.title.length < 60 && line.split(" ").length <= 2) stage.title += ` ${line}`;
				else stage.summary = `${stage.summary ?? ""} ${line}`.trim();
				continue;
			}
		}

		const gate = line.match(GATE_HEADER);
		if (gate) {
			closeUnit();
			inGate = true;
			summaryOpen = false;
			continue;
		}
		if (inGate && stage) {
			if (line.startsWith("☐")) stage.gate.push(line.slice(1).trim());
			else if (stage.gate.length) stage.gate[stage.gate.length - 1] += ` ${line}`;
			continue;
		}

		const header = line.match(UNIT_HEADER);
		if (header && stage && !line.startsWith("Chapters:") && !line.startsWith("Own:")) {
			closeUnit();
			summaryOpen = false;
			const { title, flags } = splitFlags(header[2]!);
			unit = { topic: { id: header[1]!, title, prereqs: [], stage: stage.id, ...(flags.length ? { flags } : {}) }, section: "source", chapters: [], own: [], checkpoint: [] };
			continue;
		}
		if (!unit) continue;

		if (line.startsWith("Chapters:")) {
			unit.section = "chapters";
			unit.chapters.push(line);
			continue;
		}
		if (line.startsWith("Own:")) {
			unit.section = "own";
			unit.own.push(line);
			continue;
		}
		if (/^Checkpoint\b/.test(line)) {
			unit.section = "checkpoint";
			continue;
		}
		if (unit.section === "source") {
			let lastLabel: string | null = null;
			for (const piece of line.split(/\s*[|;]\s*/).filter((p) => p.trim() !== "")) {
				const m = piece.trim().match(SOURCE);
				const label: string | undefined = (m?.[1] ?? lastLabel)?.trim();
				if (!m || !label) {
					problems.push(`Unit ${unit.topic.id}: could not read the page line "${piece.trim()}".`);
					continue;
				}
				lastLabel = label;
				if (!labels.includes(label)) labels.push(label);
				const start = Number(m[3]);
				const end = m[4] ? Number(m[4]) : start;
				const range: PageRange = { book: bookKeyOf(label), start, end };
				if (end < start) problems.push(`Unit ${unit.topic.id}: pages ${start}–${end} run backwards.`);
				if (!unit.topic.anchor) unit.topic.anchor = range;
				else unit.topic.seeAlso = [...(unit.topic.seeAlso ?? []), range];
			}
		} else if (unit.section === "chapters") unit.chapters.push(line);
		else if (unit.section === "own") unit.own.push(line);
		else if (unit.section === "checkpoint") {
			if (line.startsWith("☐")) unit.checkpoint.push(line.slice(1).trim());
			else if (unit.checkpoint.length) unit.checkpoint[unit.checkpoint.length - 1] += ` ${line}`;
		}
	}
	closeStage();

	if (topics.length === 0) problems.push("No units were found. This reader understands roadmaps written as unit blocks (a code like E04, a title, 'PDF pp.' pages, 'Needs:', 'Own:', and a checkpoint).");
	problems.push(...roadmapProblems(topics));
	return {
		roadmap: { version: ROADMAP_FORMAT_VERSION, topics, ...(stages.length ? { stages } : {}), books: labels.map((label) => ({ label, key: bookKeyOf(label) })) },
		bookLabels: labels,
		problems,
	};
}
