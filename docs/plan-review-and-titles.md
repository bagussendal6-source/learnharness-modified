# Prompt: session titles, living notes, completion + final exam, "Welcome back" review

Paste everything below into a fresh Claude Code session in `lh/`. Read `AGENTS.md` and `docs/development.md` first and follow their conventions (pure logic in `src/core`, tests in `tests/`, `npm test` stays deterministic: no LLM, no network).

## Product idea (the learner's own words, condensed)

A chat is ONE material. A chat has explicit **Start session** and **Close session**.
- Start after a long gap -> warm-up retrieval so the learner is not lost.
- Close -> AI writes ONE new page of notes for what this session added. Notes only ever GROW: the learner never edits earlier pages to make room for new ones. Page 2 must read as a continuation of page 1 (same terms, same structure, refers back instead of repeating).
- When every node of the plan has been passed, the chat says so, and offers a hard final exam. After the score the learner is free to keep studying, review, or stop. The point is that they KNOW the plan is done.

Research basis (summarize in the docs you write; figures came from abstracts, verify before citing): spaced retrieval beats massed (g ~ 0.74), expanding schedules are not clearly better than uniform, number of retrievals per item matters; generative note-taking beats verbatim copying; confidently held errors are corrected best with an explicit refutation plus explanation, but fade within about a week, so they need re-review. Evidence that "error logs" help is weak (blogs only), so do not oversell them.

## Order of work (each step shippable alone)

1. Feature 1: AI session titles
2. Feature 2: Close session + append-only notes
3. Feature 3: completion marker + final exam
4. Feature 4: Start session / "Welcome back" review (draws from notes and exam results, so it comes last)

---

## Feature 1: AI session titles

### Current state (verified)
- `titleFromPrompt` in `src/core/contracts/graph.ts` (~line 361) cuts the first message to 72 chars. Only title logic today.
- `renameChat` in `src/store/chats.ts` (~line 177) sets `record.title`, does NOT bump `updatedAt`.
- `src/server/tag-suggest.ts` is the pattern: one cheap-tier call (role `"auditor"` via `resolveRoleSpec`, currently `claude-haiku-5-5` in `data/settings.json`), `runSubmitAgent`, ~3,500-char digest, route at `app/api/chats/[id]/tags/suggest/route.ts`, usage not added to the session cost log.
- There is NO "title edited by learner" marker. Add one.

### Build
1. `titleSource` on the chat record: `"prompt" | "ai" | "manual"` (absent = `"prompt"`). Update `src/core/contracts/chat.ts` and the store. Old records must keep working. Click-to-edit rename sets `"manual"`.
2. `src/server/title-suggest.ts` modeled on `tag-suggest.ts`. Output ONE title <= `TITLE_MAX_CHARS` describing the MATERIAL (e.g. "Teorema Green: hubungan integral garis dan lipat dua"), in the learner's language. Pure helpers (digest, sanitize/clamp) in `src/core`.
3. Auto-title after the learner's N-th turn (named constant, start at 2) when `titleSource === "prompt"`; apply with `titleSource = "ai"`. NEVER overwrite `"manual"`. Failure keeps the prompt title, no toast.
4. Manual **Generate name** for old sessions: per-session menu item (session row and header) -> new route (e.g. `POST /api/chats/[id]/title/suggest`) returns a suggestion; learner accepts / edits / rejects (same flow as tag suggestions); accepting sets `"manual"`.
5. Bulk **Generate names for untitled sessions**: over chats with `titleSource` absent or `"prompt"`, sequential, progress + cancel, skip empty sessions, show all suggestions for review before applying. Never rename silently.
6. Tests: migration of old records, never overwriting `"manual"`, output clamping, bulk filter. Mock the model call the way tag-suggest tests do.

Done when: new sessions get a real title after a couple of turns; learner-typed titles are never replaced; an old session gets a suggested title in one click; `npm test` passes.

---

## Feature 2: Close session + append-only notes

### Behavior
- One note document per chat, made of **session pages** (Page 1, Page 2, ...). Stored as plain markdown files next to the learning records (inspectable, openable in Obsidian), with a view inside the app.
- **Close session** runs one generation: input = previous pages of THIS chat + this session's transcript (and the graph delta if cheap to get). Output = ONE new page.
- Page template (same sections every time): what was learned this session; key rules/formulas; worked example(s); where I got stuck; misconceptions (what I believed -> why it was wrong -> the correct statement, with explanation); open questions.
- Continuity rules for the generator: reuse the exact terms/notation of earlier pages; do not re-explain what earlier pages cover, point to it ("see Page 1, concept 3"); keep the same section order. If something on an earlier page turns out wrong, write a **Correction** item on the NEW page. NEVER edit or delete earlier pages.
- Learner reviews the draft before it is saved; can edit their own page freely. AI-written text is marked as such.
- Prompt the learner to add ONE sentence in their own words per topic (generative effect). Hand-copying the AI text verbatim is the weakest use of the note; say so in the UI help text, do not enforce it.
- Closing a session with nothing new produces no page.

### Assumptions to confirm (ask the learner if still unresolved)
- One note document per chat, with sub-topic headings inside, rather than several notes per chat.

### Verify first, report before building
- What data identifies "this session" inside one chat (a chat may be reopened many times): is there a session/segment boundary, or must Start/Close create one? Where does it live (chat record vs `data/`)?
- What the extractor/graph delta offers cheaply as input, versus using the transcript alone.
- Cost: use the strong or cheap tier? Propose, with a token estimate.

### Tests
Page numbering, "no new page when nothing new", earlier pages are byte-identical after a new close, continuity prompt contains prior pages (assert on the prompt builder, not on model output).

---

## Feature 3: Completion marker + final exam

### Current state (verified by search; confirm)
- Plan node status is only `current | visited | upcoming` (`src/core/contracts/plan.ts`), derived from WHERE tagged quiz calls have been, not from results. No "mastered" state.
- The in-chat plan diagram is deliberately all-white ("statuses never show in the transcript", `components/plan-block.tsx`); real progress shows in the plan popup/window (e.g. "3/4").
- No code and no teacher prompt (`src/agent/prompts/teacher/*.md`) reacts when every node is visited. A session never knows it is done.

### Build
1. Pure function `planIsComplete(statuses)` in `src/core`: true when every node is `visited`. Tested.
2. When it becomes true, show a clear marker in the chat. Wording must say the learner has **passed through** all the material, NOT that they mastered it (visited != mastered).
3. Offer a **final exam** (skippable). Questions span the WHOLE plan, mix difficulty (not all hard), include questions that combine several concepts, and demand reasoning rather than recall of wording. Reuse the practice-session engine if it can take a chosen set of propositions/nodes (see `PRACTICE_PROBLEM_TOOL` / `PRACTICE_CONCLUDE_TOOL` in `src/core/`).
4. Result: overall score + per-concept breakdown (strong / shaky) + the reason for each marking + the ability to dispute a single question. Suggest review for the shaky ones.
5. After the result the learner is free to continue studying, review, or stop. Nothing is locked.
6. Result feeds: the final notes page (Feature 2) and the review selection (Feature 4).

### Decision recorded (assumed; learner leaned this way)
README says the graph stores ideas and connections, NOT ratings of ability. So the score is shown to the learner and written into the notes page, but is NOT stored in the graph as an ability score. Only per-proposition understanding levels may be adjusted by the exam (e.g. -> `solid`, or `shaky` when missed). Do not change that principle without asking.

### Verify first, report before building
- Can the practice engine accept an externally chosen question set?
- How to keep LLM-written questions and LLM grading honest: show grading reasons, allow dispute, avoid questions answerable by memorized wording.
- Is `visited` reliable as the completion signal when the plan is rewritten mid-session (`plan_init` is re-callable)?

---

## Feature 4: Start session / "Welcome back"

### Flow
After a gap (named constant, start at 5 days, settable), opening the chat shows a short gate: **Pemanasan** (warm up) or **Langsung lanjut** (skip).
1. **Where we are** (~4 lines, read-only): the session goal, what is solid, where it stopped and why the next concept needs it. Built from the notes pages and the session.
2. **Warm-up retrieval**: pick the concepts that are prerequisites of the stopping point. Priority: items from the notes marked stuck / misconception not yet resolved, then understanding level `shaky` / `resisted`, then longest untouched. Cap by ITEM COUNT (default ~3 to 6), never by minutes (the earlier "3-5 minutes" was a guess). Ask WITHOUT showing the answer; learner answers in their own words (reuse the thinking fields); then feedback and a short correction. Forgot completely -> brief re-explain, then re-test with a slightly changed question.
3. Adaptive: clean first three answers -> skip the rest; many lost -> add items.
4. Optional **Review lebih dalam** button for the whole chat, incremental and stoppable.
5. Continue from the stopping point; if a foundation is missing, re-teach it first (`docs/teaching-methodology.md`: never build on what is not held).
6. Record last-reviewed timestamps and updated levels (feeds later scheduling, e.g. FSRS). No new session is created; the review lives in the same chat so sessions do not pile up.

### Assumption to confirm
- Whether the gate also appears automatically on long idle, or only when the learner presses Start. Default to: automatic offer on long idle, plus a manual Start button.

### Verify first, report before building
- Is the extractor's understanding level reliable enough to rank items (`docs/vision.md` says its treatment is "TBD")? If not, fall back to recency/position plus the notes' stuck/misconception items.
- Recovering the stopping point and prerequisite chain from `src/core/plan-tree.ts` and the graph.
- Idle time source: `updatedAt` is not bumped by settings/rename, which is correct here.

---

## Rules
- Pure selection/ranking logic in `src/core` with unit tests; no LLM in tests.
- No new dependencies and no knowledge-graph schema changes without asking; propose them instead.
- For every "Verify first" block: write findings and a concrete design in `docs/`, then stop for review before implementing that part.
- Small commits per step.
