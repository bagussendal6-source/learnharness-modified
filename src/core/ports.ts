/**
 * Storage ports (the hexagonal seams — vision §1 "storage stays swappable").
 *
 * One port per ENTITY, with domain operations — never one generic
 * key/value interface. Core and the service layer that orbits it code
 * against these types only; concrete adapters live in src/store/ (fs
 * JSON/JSONL today, SQLite drop-in later) and are wired exactly once, in
 * the composition root (src/server/stores.ts). Dependencies point one way:
 * adapters may import core; core NEVER imports an adapter.
 */

import type { LhMessage } from "./native-messages.ts";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	GraphChain,
	GraphNode,
	JobKind,
	JobRecord,
	ExtractionRunUsage,
	PlanTree,
	Position,
	CoverageEntry,
	SessionCheckpoint,
	TurnUsage,
	NotesSource,
	TitleSource,
} from "./contracts.ts";
import type { ProgressDoc, RoadmapDoc, RoadmapMeta, RoadmapSetupState, TopicProgress } from "./contracts/roadmap.ts";
import type { BookManifest, BookOutlineNode, BookPage } from "./contracts/books.ts";
import type { UserSettings } from "./settings.ts";
import type { NotePage, NotesRecord } from "./notes.ts";
import type { ExamMeta } from "./exam.ts";

// ─── ChatStore — the session record's home (data/chats) ─────────────────────

export interface ChatStore {
	/** Create a session record (persisted immediately). */
	/** Create a session record; kind "practice" marks a practice session
	 *  (absent = teach, the default). */
	createChat(title: string, kind?: "practice", folder?: string): ChatRecord;
	/** Set a session's folder and/or tags (undefined = leave; folder null =
	 *  unfile). Like rename: not conversation activity, updatedAt stays put;
	 *  announces chats-changed. */
	setOrganization(id: string, patch: { folder?: string | null; tags?: string[] }): ChatRecord;
	/** Mark a (practice-kind) session as the final exam of `meta.parentChatId`.
	 *  A list-shape write like rename: announces chats-changed. */
	setExam(id: string, meta: ExamMeta): ChatRecord;
	/** Move every session in folder `from` to `to` (null = unfile). Returns
	 *  how many sessions moved. */
	retargetFolder(from: string, to: string | null): number;
	/** The full record, or null if unknown id / corrupt file. */
	getChat(id: string): ChatRecord | null;
	/** All sessions, newest activity first (the sidebar's list view). */
	listChats(): ChatSummary[];
	/** Persist the full native message list (the record IS the agent
	 * state — Wave B, owner-approved 2026-09-26). */
	saveMessages(id: string, messages: LhMessage[]): void;
	/** Persist the session plan tree (plan tools call this in execute). */
	saveTree(id: string, tree: PlanTree): void;
	/** Append one usage entry to the record's turn log (the money channel,
	 * 2026-09): idempotent per turn id — each request carries its own, so
	 * a turn persisted twice appends once while continuation turns (which
	 * share a response message id) each keep their usage. */
	appendTurnUsage(id: string, entry: TurnUsage): void;
	/** Append one extraction-run usage entry — idempotent per startedAt. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): void;
	/** Persist the per-chat model/thinking settings (the model control).
	 *  Replace-whole: the picker sends the complete settings object. */
	saveSettings(id: string, settings: ChatSettings): void;
	/** Rename a session (the header's click-to-edit title, 2026-09-17).
	 * Like saveSettings: a rename is NOT conversation activity — updatedAt
	 * stays put, so sidebar order never churns on a rename. */
	renameChat(id: string, title: string, source?: TitleSource): ChatRecord;
	/** Delete the session record entirely (session-deletion wave 6, owner
	 *  2026-09-22). False when the id is unknown. The graph-ledger purge and
	 *  job cleanup are the caller's choreography (core/graph-deletion.ts +
	 *  the DELETE route), not the store's. */
	deleteChat(id: string): boolean;
}

// ─── GraphStore — the append-only evidence ledgers (data/graph) ──────────────
// Chains are the stored truth (owner, 2026-09-30): nodes + reasoning
// chains; edges are a DERIVED view (core/graph.ts) and never touch this
// seam. Reads return the raw append-order lines; merging chain assertions
// by (premises, conclusion) is DERIVED in core/graph.ts — the store never
// decides. The extraction pipeline is the sole writer; this read surface
// stays.

export interface GraphStore {
	/** Append one GraphNode (ids are unique — no merging needed). */
	appendNode(node: GraphNode): void;
	/** Raw node lines in append order. */
	readNodes(): GraphNode[];

	/** Append one chain ASSERTION (a second session asserting the same
	 *  (premises, conclusion) appends another line; readers merge). */
	appendChain(assertion: GraphChain): void;
	readChains(): GraphChain[];

	/** Append one emission checkpoint. */
	appendCheckpoint(checkpoint: SessionCheckpoint): void;
	readCheckpoints(): SessionCheckpoint[];
	/** Message-granular extraction coverage (vision-extraction-coverage.md):
	 *  append-only; one line per covered message. The chat-extraction
	 *  checkpoint — "uncovered" is derived from these, never tracked. */
	appendCoverage(entry: CoverageEntry): void;
	readCoverage(): CoverageEntry[];

	/** Append one cluster-naming run's usage (graph-global money channel) —
	 *  idempotent per startedAt. */

	/** Upsert one imported-notes source record (config.SOURCES_FILE — a
	 *  JSON map, not a ledger; an upsert keeps the existing usage log). */
	upsertSource(source: NotesSource): void;
	/** Every notes source record, by id order-insensitive. */
	readSources(): NotesSource[];
	/** Append one run's usage to a source record — idempotent per
	 *  startedAt, mirroring ChatRecord.extractions. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void;

	/** The layout ledger (config.POSITIONS_FILE): nodeId → resting {x,y}.
	 *  WRITTEN ONLY by the incremental settle after a merge (core/layout.ts
	 *  settleGraphLayout) — read-only for everything else. */
	readPositions(): Record<string, Position>;
	/** Replace the whole ledger (the settle is a full-graph computation). */
	writePositions(positions: Record<string, Position>): void;

	/** THE DESTRUCTIVE SEAM (session-deletion wave 6, owner 2026-09-22 —
	 *  the first non-append operation on these ledgers): atomically
	 *  replace the full contents of any subset of the six rewritable
	 *  ledgers. Each provided array is written to a temp file and renamed
	 *  over the ledger (crash-safe: a torn write never replaces the
	 *  original); absent keys leave their ledger untouched. The pure
	 *  computation is core/graph-deletion.ts — the store only makes the
	 *  replacement atomic. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
	}): void;
}

// ─── JobStore — background sub-agent jobs (data/jobs) ─────────────────────────

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	/** First activity line (defaults to "starting"). */
	activity?: string;
	/** Saved on the job before its worker is spawned. */
	input?: unknown;
}

/** Mergeable fields — identity (id, kind, chatId, toolCallId, createdAt) is immutable. */
export type JobPatch = Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>;

export interface JobStore {
	/** Create a running job (keyed by toolCallId for spawn dedup). */
	createJob(init: CreateJobInit): JobRecord;
	getJob(id: string): JobRecord | null;
	/** Merge a patch into the record; null if unknown id. */
	updateJob(id: string, patch: JobPatch): JobRecord | null;
	/** All jobs for a chat, newest activity first. */
	listJobs(chatId: string): JobRecord[];
	/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
	findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null;
	/** Delete every job record for a chat — running or finished (session-
	 *  deletion wave 6). Returns how many files were removed. The deletion
	 *  route refuses while jobs are still running, so by the time this
	 *  fires every record is terminal. */
	deleteJobsForChat(chatId: string): number;
}

// ─── SettingsStore — THE user settings record (settings-storage wave, 2026-09-19) ──

/**
 * The one record for every non-secret product preference (core/settings.ts
 * UserSettings — delta semantics, see that module's doc). The store is
 * replace-whole on the RECORD; per-section scoping is a server-band concern
 * (single process, no stale-client hazard to defend against at this seam).
 * Schema-version lazy migration happens inside readSettings, never in
 * the callers. (The legacy default-settings.json fold died with the chat
 * section — per-session models, owner 2026-09-28.)
 */
export interface SettingsStore {
	/** The sanitized record, or null when none exists yet (first boot). */
	readSettings(): UserSettings | null;
	/** Persist the record (replace-whole). Callers pass a SANITIZED record. */
	writeSettings(settings: UserSettings): void;
}

// ─── PromptOverrideStore — per-segment system-prompt overrides (2026-09-19) ──

/**
 * User text overriding ONE source prompt segment (the shared base or one
 * numeric fragment), stored at the data-dir seam mirroring the source
 * layout (config.PROMPTS_OVERRIDE_DIR). File presence is NOT the override:
 * the settings record's agent.prompts switch is the explicit on/off, so a
 * user can keep a customized file on disk while running the source default.
 * The segment LIST is always derived from source at runtime — see the
 * adapter (src/store/prompt-overrides.ts) for the loader rules.
 */
export interface PromptOverrideStore {
	/** Every override path currently on disk ("system-prompt.md",
	 *  "teacher/20-teaching.md", ...), POSIX-relative, sorted. */
	listOverrides(): string[];
	/** The override text, or null when the path has no file. */
	readOverride(segmentPath: string): string | null;
	/** Persist override text for a segment path (creates parents). */
	writeOverride(segmentPath: string, text: string): void;
	/** Remove the override file, if present (switches are untouched — an
	 *  on-switch with no file composes the source default, inert). */
	deleteOverride(segmentPath: string): void;
}

// ─── NotesStore — the per-chat living notes (core/notes.ts) ─────────────────

/**
 * One notes document per chat (data/notes/<chatId>.json). Pages are
 * APPEND-ONLY: there is no way through this port to edit or remove an
 * earlier page — the one mutable field is a page's own-words text.
 */
/** A roadmap folder's own data (data/roadmaps/<folderId>/). The folder FLAG
 *  lives in the library; everything the roadmap owns lives behind this port. */
export interface RoadmapStore {
	/** The folder's meta, or null when no roadmap data exists for this id. */
	readMeta(folderId: string): RoadmapMeta | null;
	/** Create the roadmap's data directory + meta (state "setup"); returns the
	 *  existing meta untouched when it is already there (restore, retries). */
	ensureRoadmap(folderId: string): RoadmapMeta;
	/** Move the setup state; null for an unknown id. */
	setState(folderId: string, state: RoadmapSetupState): RoadmapMeta | null;
	/** The saved roadmap (roadmap.json), or null when none was imported yet. */
	readRoadmap(folderId: string): RoadmapDoc | null;
	/** Replace the saved roadmap. */
	writeRoadmap(folderId: string, roadmap: RoadmapDoc): void;
	/** The learner's progress (progress.json); an empty doc when there is none yet. */
	readProgress(folderId: string): ProgressDoc;
	/** Merge `patch` into one unit's progress (created as not_started if new) and
	 *  stamp updatedAt. The ONLY way progress changes — one writer. */
	updateTopic(folderId: string, topicId: string, patch: Partial<Omit<TopicProgress, "updatedAt">>): TopicProgress;
}

/** A roadmap folder's ingested books (data/roadmaps/<folderId>/books/<bookId>/).
 *  A book is written ONCE at ingest and only read afterwards. */
export interface BookStore {
	list(folderId: string): BookManifest[];
	readManifest(folderId: string, bookId: string): BookManifest | null;
	readOutline(folderId: string, bookId: string): BookOutlineNode[];
	/** Every page's saved text, in page order (cached per process). */
	readPages(folderId: string, bookId: string): BookPage[];
	/** Save a freshly ingested book (manifest, outline, pages, the PDF copy). */
	write(folderId: string, book: { manifest: BookManifest; outline: BookOutlineNode[]; pages: BookPage[]; sourcePdf: string }): void;
	/** Merge fields into an existing manifest (e.g. the roadmap's book key). */
	patchManifest(folderId: string, bookId: string, patch: Partial<Pick<BookManifest, "key">>): BookManifest | null;
	/** Absolute path of the saved PDF copy (for rendering page images). */
	sourcePath(folderId: string, bookId: string): string;
}

export interface NotesStore {
	/** The chat's notes, or null when it has none (or the file is unreadable). */
	readNotes(chatId: string): NotesRecord | null;
	/** Append the next page. The page's number must be exactly pages.length + 1
	 *  (a stale caller is refused, never silently reordered). Returns the
	 *  updated record and announces notes-changed. */
	appendPage(chatId: string, page: NotePage): NotesRecord;
	/** Edit a saved page's own-words field — nothing else on a page changes. */
	setOwn(chatId: string, pageNumber: number, own: string): NotesRecord;
	/** Remove the chat's notes (session deletion). False when there were none. */
	deleteNotes(chatId: string): boolean;
}

// ─── AuthStore — BYOK provider keys (auth-keys wave, 2026-09-19) ────────────

/**
 * The long-standing flat {VAR: value} auth.json map (config.AUTH_FILE) —
 * the same file the Electron app has always hand-edited, now first-class
 * server-managed. Values are opaque strings: shape validation is a
 * server-band concern (core/auth-keys.ts validateKeyShape — the store
 * persists what it is given); env precedence is a server-band concern
 * too (src/server/keys.ts). Unknown vars ride along verbatim.
 */
export interface AuthStore {
	/** The whole map — absent or corrupt file = {} ("no keys yet", the
	 *  documented first-boot state). Never throws. */
	authVars(): Record<string, string>;
	/** Set one VAR (atomic write, mode 0600 always, other vars preserved). */
	setAuthVar(name: string, value: string): void;
	/** Remove one VAR if present (absent = no-op, still a silent success). */
	deleteAuthVar(name: string): void;
}

