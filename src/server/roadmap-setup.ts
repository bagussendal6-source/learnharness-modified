import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractLines } from "../agent/books/pdf-extract.ts";
import { matchesBookLabel } from "../core/book-index.ts";
import type { RoadmapBookStatus, RoadmapDoc, RoadmapSetupView, RoadmapUnitView } from "../core/contracts/roadmap.ts";
import { checkCounts, verifyRoadmap, type BookView } from "../core/roadmap-verify.ts";
import { parseRoadmapText } from "../core/roadmap-parse.ts";
import { assignBookKeys, roadmapFolderId, type BookResult } from "./books.ts";
import { stores } from "./stores.ts";

/**
 * A ROADMAP FOLDER'S SETUP, server side: import the written roadmap (read by
 * the deterministic reader, core/roadmap-parse.ts — a program copies the
 * structure exactly, it does not guess), line it up with the books added to
 * the folder, check every page range against the books' own tables of
 * contents, and let the learner approve. Nothing is learned from until the
 * learner approves.
 */

export type SetupResult<T extends object = object> =
	| ({ ok: true } & T)
	| { ok: false; status: 400 | 404 | 409 | 422; code: string; error: string; problems?: string[] };

const failWith = (r: Extract<BookResult, { ok: false }>): SetupResult<never> => r;
const MAX_ROADMAP_BYTES = 5 * 1024 * 1024;

function bookViewFor(folderId: string, key: string): BookView | null {
	const book = stores.bookStore.list(folderId).find((b) => b.key === key);
	if (!book) return null;
	return { pages: book.pages, outline: stores.bookStore.readOutline(folderId, book.id) };
}

/** Import the roadmap from its text. Anything the reader can't understand is
 *  returned as `problems` and NOTHING is saved — the learner fixes the file. */
export function importRoadmapText(rawFolder: unknown, text: unknown): SetupResult<{ units: number; stages: number }> {
	const folder = roadmapFolderId(rawFolder);
	if (!("folderId" in folder)) return failWith(folder);
	if (typeof text !== "string" || text.trim() === "") return { ok: false, status: 400, code: "empty", error: "The roadmap is empty." };
	if (text.length > MAX_ROADMAP_BYTES) return { ok: false, status: 400, code: "too_big", error: "That roadmap is over 5 MB." };
	const { roadmap, problems } = parseRoadmapText(text);
	if (problems.length > 0) {
		return { ok: false, status: 422, code: "unreadable", error: `The roadmap could not be read cleanly (${problems.length} problem${problems.length === 1 ? "" : "s"}). Nothing was saved.`, problems: problems.slice(0, 12) };
	}
	const topics = roadmap.topics.map((t) => ({ ...t, mapping: "proposed" as const }));
	stores.roadmapStore.writeRoadmap(folder.folderId, { ...roadmap, topics });
	// A new roadmap is unapproved again; progress (keyed by topic id) is untouched.
	stores.roadmapStore.setState(folder.folderId, "setup");
	assignBookKeys(folder.folderId);
	return { ok: true, units: topics.length, stages: roadmap.stages?.length ?? 0 };
}

/** Import from an uploaded file: PDF (read as lines), or plain text / Markdown. */
export async function importRoadmapFile(rawFolder: unknown, rawName: unknown, bytes: Uint8Array): Promise<SetupResult<{ units: number; stages: number }>> {
	const folder = roadmapFolderId(rawFolder);
	if (!("folderId" in folder)) return failWith(folder);
	const name = typeof rawName === "string" ? path.basename(rawName) : "";
	const ext = path.extname(name).toLowerCase();
	if (bytes.length === 0) return { ok: false, status: 400, code: "empty", error: "The file is empty." };
	if (bytes.length > MAX_ROADMAP_BYTES) return { ok: false, status: 400, code: "too_big", error: "That roadmap file is over 5 MB." };
	if (ext === ".pdf") {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-roadmap-"));
		try {
			const file = path.join(dir, "roadmap.pdf");
			fs.writeFileSync(file, bytes);
			let text: string;
			try {
				text = await extractLines(file);
			} catch (error) {
				return { ok: false, status: 422, code: "unreadable", error: `Could not read that PDF: ${error instanceof Error ? error.message : "unknown error"}.` };
			}
			return importRoadmapText(rawFolder, text);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	if (ext === ".txt" || ext === ".md" || ext === ".markdown") return importRoadmapText(rawFolder, Buffer.from(bytes).toString("utf-8"));
	return { ok: false, status: 400, code: "bad_type", error: "Use a PDF, .txt or .md roadmap file, or paste the text." };
}

/** Everything the setup screen draws. */
export function roadmapSetupView(rawFolder: unknown): SetupResult<{ setup: RoadmapSetupView }> {
	const folder = roadmapFolderId(rawFolder);
	if (!("folderId" in folder)) return failWith(folder);
	const folderName = stores.libraryStore.view().folders.find((f) => stores.libraryStore.getFolderMeta(f)?.id === folder.folderId) ?? "";
	const meta = stores.roadmapStore.readMeta(folder.folderId);
	const doc = stores.roadmapStore.readRoadmap(folder.folderId);
	const added = stores.bookStore.list(folder.folderId);

	const books: RoadmapBookStatus[] = (doc?.books ?? []).map(({ label, key }) => {
		const fits = added.filter((b) => matchesBookLabel(label, b));
		const one = fits.length === 1 ? fits[0]! : null;
		return { label, key, file: one ? one.sourceName : null, pages: one ? one.pages : null, ambiguous: fits.length > 1 };
	});
	const claimed = new Set((doc?.books ?? []).flatMap(({ label }) => added.filter((b) => matchesBookLabel(label, b)).map((b) => b.id)));
	const otherBooks = added.filter((b) => !claimed.has(b.id)).map((b) => ({ id: b.id, file: b.sourceName, pages: b.pages }));

	const blockers: string[] = [];
	let roadmapView: RoadmapSetupView["roadmap"] = null;
	let counts = { ok: 0, pending: 0, warn: 0, error: 0 };
	if (!doc) blockers.push("Add your roadmap.");
	else {
		const checks = new Map(verifyRoadmap(doc, (key) => bookViewFor(folder.folderId, key)).map((c) => [c.topicId, c]));
		counts = checkCounts([...checks.values()]);
		const labelOf = new Map((doc.books ?? []).map((b) => [b.key, b.label]));
		const unitView = (t: RoadmapDoc["topics"][number]): RoadmapUnitView => {
			const c = checks.get(t.id)!;
			const a = t.anchor;
			const extra = t.seeAlso?.length ?? 0;
			return {
				id: t.id,
				title: t.title,
				flags: t.flags ?? [],
				pages: a ? `${labelOf.get(a.book) ?? a.book} PDF pp. ${a.start}–${a.end}${extra ? ` · +${extra} more span${extra === 1 ? "" : "s"}` : ""}` : "no pages",
				check: c.level,
				notes: c.notes,
			};
		};
		const stages = (doc.stages ?? [{ id: "-", title: "Units", gate: [] }]).map((s) => ({
			id: s.id,
			title: s.title,
			gate: s.gate.length,
			units: doc.topics.filter((t) => (doc.stages ? t.stage === s.id : true)).map(unitView),
		}));
		roadmapView = { units: doc.topics.length, stages };
		for (const b of books) {
			if (b.ambiguous) blockers.push(`More than one added file fits "${b.label}". Remove the extra one.`);
			else if (!b.file) blockers.push(`Add the book "${b.label}".`);
		}
		if (counts.error > 0) blockers.push(`${counts.error} unit${counts.error === 1 ? " has" : "s have"} page ranges that can't be right (see the list).`);
	}
	return { ok: true, setup: { folder: folderName, state: meta?.state ?? "setup", roadmap: roadmapView, books, otherBooks, counts, canApprove: blockers.length === 0, blockers } };
}

/** The learner approves the page mapping: topics become "approved" and the
 *  folder moves from setup to active. Refused while anything blocks it. */
export function approveRoadmap(rawFolder: unknown): SetupResult<{ units: number }> {
	const folder = roadmapFolderId(rawFolder);
	if (!("folderId" in folder)) return failWith(folder);
	const view = roadmapSetupView(rawFolder);
	if (!view.ok) return view;
	if (!view.setup.canApprove) return { ok: false, status: 409, code: "blocked", error: "The roadmap can't be approved yet.", problems: view.setup.blockers };
	const doc = stores.roadmapStore.readRoadmap(folder.folderId)!;
	stores.roadmapStore.writeRoadmap(folder.folderId, { ...doc, topics: doc.topics.map((t) => ({ ...t, mapping: "approved" as const })) });
	stores.roadmapStore.setState(folder.folderId, "active");
	return { ok: true, units: doc.topics.length };
}
