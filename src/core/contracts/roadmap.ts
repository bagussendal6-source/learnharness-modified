/**
 * Roadmap-folder contracts — the shapes of a folder that teaches one subject
 * from a roadmap and a set of textbooks (docs: the roadmap-folder plan).
 *
 * Pure types + tiny constants, browser-safe. Two stores meet here:
 *  - the library (data/library.json) holds the FOLDER FLAG (FolderMeta): a
 *    folder is "regular" unless it carries meta saying otherwise, so every
 *    pre-roadmap folder stays regular with no migration;
 *  - the roadmap store (data/roadmaps/<folderId>/) holds everything the
 *    roadmap owns: meta.json now, roadmap.json / progress.json / books /
 *    index as later build steps land.
 *
 * The folder's NAME is renameable, so roadmap data is keyed by a stable
 * `folderId`, never by the name.
 */

export const ROADMAP_FORMAT_VERSION = 1;

/** A folder's type. Absent flag reads as "regular" (course folder, unchanged). */
export type FolderType = "regular" | "roadmap";

/** The flag stored in the library for one folder. `type: "regular"` with an
 *  id means a DETACHED roadmap: its data is kept on disk and can be restored. */
export interface FolderMeta {
	id: string;
	type: FolderType;
}

/** Where a roadmap folder is in its one-time setup. "active" is reached when
 *  the roadmap, the books and the page mapping are all approved. */
export type RoadmapSetupState = "setup" | "active";

/** data/roadmaps/<folderId>/meta.json */
export interface RoadmapMeta {
	version: number;
	folderId: string;
	createdAt: string;
	state: RoadmapSetupState;
}

/** What the folder page needs to draw: GET /api/folders/:name/roadmap. */
export interface RoadmapFolderStatus {
	folder: string;
	type: FolderType;
	/** Setup progress; null for a regular folder. */
	state: RoadmapSetupState | null;
	/** A regular folder that was a roadmap before: its data is still on disk
	 *  and "Make this a roadmap folder" restores it instead of starting over. */
	hasSavedRoadmap: boolean;
}

// ─── the roadmap itself (roadmap.json) and the learner's progress ───────────

/** A topic's progress. A topic is "mastered" only by passing its check. */
export type TopicStatus = "not_started" | "learning" | "shaky" | "mastered";

/** A page span in one book. `book` is the book's id inside the folder;
 *  pages are the book's PRINTED page numbers (the citation the learner sees). */
export interface PageRange {
	book: string;
	start: number;
	end: number;
}

/** Whether the learner has reviewed the topic→pages mapping. */
export type MappingState = "proposed" | "approved" | "edited";

export interface RoadmapTopic {
	/** Stable slug, unique within the roadmap. */
	id: string;
	title: string;
	summary?: string;
	/** Topic ids that must be mastered first (the dependency order). */
	prereqs: string[];
	/** The one primary book span the topic is taught from. */
	anchor?: PageRange;
	/** Further page spans the unit also covers (other chapters, or other books). */
	seeAlso?: PageRange[];
	mapping?: MappingState;
	/** The stage the topic belongs to ("A"). */
	stage?: string;
	/** Labels the roadmap gives the unit: "DEEP", "MATH", "OPTIONAL". */
	flags?: string[];
	/** The book chapters the unit covers, as the roadmap names them. */
	chapters?: string;
	/** "Own": the ideas the learner should own after the unit. */
	own?: string;
	/** The unit's checkpoint: what the learner must do without notes. */
	checkpoint?: string[];
}

/** A stage of the roadmap and the mixed test that closes it. */
export interface RoadmapStage {
	id: string;
	title: string;
	summary?: string;
	/** The gate's tasks (a mixed test across the whole stage). */
	gate: string[];
}

/** data/roadmaps/<folderId>/roadmap.json */
export interface RoadmapDoc {
	version: number;
	topics: RoadmapTopic[];
	stages?: RoadmapStage[];
	/** The books the roadmap names, by its own label, with the short key the
	 *  topics' page ranges use. */
	books?: { label: string; key: string }[];
}

/** How hard the unit was for the learner, in the teacher's judgement backed by
 *  the checks (wrong answers, "I don't know"s). Memory for later units. */
export type StruggleLevel = "smooth" | "some" | "hard";

/** A wrong idea the learner held in this unit. `resolved` flips to true once
 *  a later check showed it corrected — a resolved one is not nagged about. */
export interface Misconception {
	believed: string;
	correct: string;
	resolved: boolean;
}

/** One entry of a unit's story: how an attempt (or sitting) ended. */
export interface ProgressEvent {
	at: string;
	status: TopicStatus;
	/** Checkpoint score 0–1 for an attempt at the checkpoint; absent for a plain sitting. */
	score?: number;
}

export interface TopicProgress {
	status: TopicStatus;
	/** Where the learner stopped, in words ("finished the second worked example"). */
	lastStop?: string;
	updatedAt: string;
	/** The unit's chat (one chat per unit) — where its transcript and notes live. */
	chatId?: string;
	/** How many times the learner attempted the unit's checkpoint. */
	attempts?: number;
	/** How the unit went — carried to later units that build on it. */
	struggle?: { level: StruggleLevel; summary: string };
	misconceptions?: Misconception[];
	history?: ProgressEvent[];
}

/** data/roadmaps/<folderId>/progress.json — a topic with no entry is not_started. */
export interface ProgressDoc {
	version: number;
	topics: Record<string, TopicProgress>;
}

// ─── what the setup screen draws (GET /api/folders/:name/roadmap/setup) ─────

/** How a roadmap's book label lines up with the books added to the folder. */
export interface RoadmapBookStatus {
	label: string;
	key: string;
	/** The added file this label matched, or null while it is missing. */
	file: string | null;
	pages: number | null;
	/** More than one added file fits the label — the learner must remove one. */
	ambiguous: boolean;
}

export interface RoadmapUnitView {
	id: string;
	title: string;
	flags: string[];
	/** "Hull PDF pp. 75–102" (+ "· 1 more span"). */
	pages: string;
	check: "ok" | "pending" | "warn" | "error";
	notes: string[];
}

export interface RoadmapSetupView {
	folder: string;
	state: RoadmapSetupState;
	roadmap: null | {
		units: number;
		stages: { id: string; title: string; gate: number; units: RoadmapUnitView[] }[];
	};
	books: RoadmapBookStatus[];
	/** Added books the roadmap does not mention. */
	otherBooks: { id: string; file: string; pages: number }[];
	counts: { ok: number; pending: number; warn: number; error: number };
	canApprove: boolean;
	/** Why approval is not possible yet, in plain words. */
	blockers: string[];
}
