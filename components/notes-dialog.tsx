"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DownloadIcon, NotebookPenIcon, XIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { cn } from "@/lib/utils";
import { NOTE_HEADINGS, previewPage, sessionStatLine, type NotePage, type NotesDraft, type SessionStat } from "@/src/core";

/**
 * The chat's NOTES. One document that only grows — a page per session — that
 * the learner copies onto PAPER, so nothing here asks them to type anything.
 *
 * Left: every session, newest last, selectable. Right: that session's page,
 * read-only. Closing a session has two honest doors:
 *   - "Close and write notes": the model drafts the next page, the learner
 *     reads it, and Save appends it (Discard throws the draft away);
 *   - "Close without notes": ends the session with an empty boundary page —
 *     no model call, nothing to review.
 * Saved pages are never edited, so the paper copy and the app never drift.
 */

type DraftState = { draft: NotesDraft; toMessageId: string; pageNumber: number; nextConcept: number; createdAt: string };

async function readError(res: Response, fallback: string): Promise<string> {
	const body = (await res.json().catch(() => ({}))) as { error?: string };
	return body.error ?? `${fallback} (${res.status})`;
}

export function NotesDialog({ chatId, open, onClose }: { chatId: string; open: boolean; onClose: () => void }) {
	const [pages, setPages] = useState<NotePage[]>([]);
	const [canClose, setCanClose] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState<null | "draft" | "save" | "close">(null);
	const [error, setError] = useState<string | null>(null);
	const [review, setReview] = useState<DraftState | null>(null);
	const [selected, setSelected] = useState<number | null>(null);
	// What happened in each session (core/sessions.ts), keyed by session number.
	const [stats, setStats] = useState<SessionStat[]>([]);
	const backdropDismiss = useBackdropDismiss(() => {
		if (busy === null) onClose();
	});

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}/notes`);
			if (!res.ok) throw new Error(await readError(res, "Could not load notes"));
			const body = (await res.json()) as { pages: NotePage[]; canClose: boolean; sessions?: SessionStat[] };
			setPages(body.pages);
			setStats(body.sessions ?? []);
			setCanClose(body.canClose);
			setSelected((cur) => (cur !== null && body.pages.some((p) => p.n === cur) ? cur : (body.pages.at(-1)?.n ?? null)));
			setLoaded(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load notes.");
		}
	}, [chatId]);

	useEffect(() => {
		if (!open) return;
		setReview(null);
		setError(null);
		setLoaded(false);
		setSelected(null);
		void refresh();
	}, [open, refresh]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && busy === null) {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, busy, onClose]);

	const reviewPage = useMemo(() => (review ? previewPage(review.draft, review.pageNumber, review.nextConcept, review.createdAt) : null), [review]);

	if (!open) return null;

	const closeWithNotes = async () => {
		setBusy("draft");
		setError(null);
		try {
			const res = await fetch(`/api/chats/${chatId}/notes/draft`, { method: "POST" });
			if (!res.ok) throw new Error(await readError(res, "Could not write the page"));
			const body = (await res.json()) as { draft: NotesDraft; toMessageId: string; pageNumber: number; nextConcept: number };
			setReview({ ...body, createdAt: new Date().toISOString() });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not write the page.");
		} finally {
			setBusy(null);
		}
	};

	const closeWithoutNotes = async () => {
		setBusy("close");
		setError(null);
		try {
			const res = await fetch(`/api/chats/${chatId}/notes/close`, { method: "POST" });
			if (!res.ok) throw new Error(await readError(res, "Could not close the session"));
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not close the session.");
		} finally {
			setBusy(null);
		}
	};

	const savePage = async () => {
		if (!review) return;
		setBusy("save");
		setError(null);
		try {
			const res = await fetch(`/api/chats/${chatId}/notes/pages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ draft: review.draft, toMessageId: review.toMessageId, edited: false }),
			});
			if (!res.ok) throw new Error(await readError(res, "Could not save the page"));
			setReview(null);
			setSelected(review.pageNumber);
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save the page.");
		} finally {
			setBusy(null);
		}
	};

	const btn = "rounded-sm border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50";
	const primary = "rounded-sm bg-foreground px-3 py-1.5 text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-50";
	const shown = reviewPage ?? pages.find((p) => p.n === selected) ?? null;

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Session notes"
				data-testid="notes-dialog"
				onClick={(e) => e.stopPropagation()}
				className="flex max-h-[88vh] w-[56rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card shadow-xl"
			>
				<div className="flex items-center gap-2 border-b border-border px-5 py-3">
					<NotebookPenIcon className="size-4" aria-hidden="true" />
					<h2 className="text-sm font-semibold text-foreground">{review ? `New page ${review.pageNumber} — not saved yet` : "Sessions and notes"}</h2>
					<div className="flex-1" />
					{!review && pages.some((p) => !p.skipped) && (
						<a href={`/api/chats/${chatId}/notes/markdown`} download className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="notes-export">
							<DownloadIcon className="size-3.5" aria-hidden="true" />
							Export .md
						</a>
					)}
					<button type="button" onClick={onClose} disabled={busy !== null} aria-label="Close notes" className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
						<XIcon className="size-4" />
					</button>
				</div>

				{error && <p className="mx-5 mt-3 rounded-sm border border-destructive/40 px-3 py-2 text-xs text-destructive" data-testid="notes-error">{error}</p>}

				<div className="flex min-h-0 flex-1">
					{/* The sessions, one row each — pick one to read its page. */}
					<nav aria-label="Sessions" data-testid="notes-sessions" className="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
						{pages.map((p) => (
							<button
								key={p.n}
								type="button"
								disabled={review !== null}
								onClick={() => setSelected(p.n)}
								data-testid={`notes-session-${p.n}`}
								className={cn(
									"mb-0.5 block w-full rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-50",
									!review && selected === p.n && "bg-accent",
								)}
							>
								<span className="flex items-baseline justify-between gap-2 text-sm text-foreground">
									<span>Session {p.n}</span>
									<span className="text-[11px] text-muted-foreground">{p.createdAt.slice(0, 10)}</span>
								</span>
								<span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{p.skipped ? "Closed without notes" : p.summary || `${p.concepts.length} concept${p.concepts.length === 1 ? "" : "s"}`}</span>
								{statFor(stats, p.n) && <span className="mt-0.5 block text-[11px] text-muted-foreground/80" data-testid={`notes-session-stat-${p.n}`}>{statFor(stats, p.n)}</span>}
							</button>
						))}
						{/* The session in progress (not closed yet): what it has done so far. */}
						{!review &&
							stats
								.filter((st) => st.current)
								.map((st) => (
									<div key="current" data-testid="notes-session-current" className="mt-1 rounded-md border border-dashed border-border px-2.5 py-1.5">
										<span className="flex items-baseline justify-between gap-2 text-sm text-foreground">
											<span>Session {st.session}</span>
											<span className="text-[11px] text-muted-foreground">in progress</span>
										</span>
										<span className="mt-0.5 block text-[11px] text-muted-foreground">{sessionStatLine(st) || "Nothing checked yet"}</span>
									</div>
								))}
						{review && (
							<div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground" data-testid="notes-session-new">
								Session {review.pageNumber} · draft
							</div>
						)}
						{loaded && pages.length === 0 && !review && <p className="px-2.5 py-1.5 text-xs text-muted-foreground">No sessions yet.</p>}
					</nav>

					{/* The selected session's page, read-only. */}
					<div className="min-w-0 flex-1 overflow-y-auto px-6 py-4" data-testid={review ? "notes-review" : "notes-pages"}>
						{!loaded ? (
							<p className="text-xs text-muted-foreground">Loading…</p>
						) : shown ? (
							<PageView page={shown} stat={review ? undefined : stats.find((st) => !st.current && st.session === shown.n)} />
						) : (
							<p className="text-xs text-muted-foreground">
								No notes yet. When you finish studying for now, press <strong>Close and write notes</strong> — the page for this session is written here, and every later session adds the next one. Prefer none? <strong>Close without notes</strong> ends the session without a page.
							</p>
						)}
					</div>
				</div>

				<div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
					{review ? (
						<>
							<span className="mr-auto text-xs text-muted-foreground">Read it through — this is the page you will copy onto paper.</span>
							<button type="button" disabled={busy !== null} onClick={() => setReview(null)} className={btn}>Discard</button>
							<button type="button" disabled={busy !== null} onClick={() => void savePage()} className={primary} data-testid="notes-save">
								{busy === "save" ? "Saving…" : `Save page ${review.pageNumber}`}
							</button>
						</>
					) : (
						<>
							{!canClose && loaded && <span className="mr-auto text-xs text-muted-foreground">Nothing new since the last close.</span>}
							<button type="button" disabled={busy !== null || !canClose} onClick={() => void closeWithoutNotes()} className={btn} data-testid="notes-close-without">
								{busy === "close" ? "Closing…" : "Close without notes"}
							</button>
							<button type="button" disabled={busy !== null || !canClose} onClick={() => void closeWithNotes()} className={primary} data-testid="notes-close-session">
								{busy === "draft" ? "Writing the page…" : "Close and write notes"}
							</button>
						</>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="mt-4">
			<h4 className="text-[11px] uppercase tracking-wider text-muted-foreground">{title}</h4>
			{children}
		</div>
	);
}

/** "+3 steps · 5/7 checks · warm-up" for a closed session, or null. */
function statFor(stats: readonly SessionStat[], n: number): string | null {
	const st = stats.find((s) => !s.current && s.session === n);
	const line = st ? sessionStatLine(st) : "";
	return line || null;
}

/** One session's page, read-only — laid out to be copied by hand. */
function PageView({ page, stat }: { page: NotePage; stat?: SessionStat }) {
	const list = (items: readonly string[]) => (
		<ul className="mt-1 list-disc space-y-1 pl-4 text-sm leading-relaxed text-foreground">
			{items.map((s, i) => (
				<li key={i}>{s}</li>
			))}
		</ul>
	);
	return (
		<article data-testid={`notes-page-${page.n}`}>
			<h3 className="text-base font-semibold text-foreground">
				Session {page.n} <span className="text-sm font-normal text-muted-foreground">· {page.createdAt.slice(0, 10)}</span>
			</h3>
			{stat && (stat.newSteps.length > 0 || stat.checks > 0 || stat.warmup) && (
				<p className="mt-1 text-xs text-muted-foreground" data-testid="notes-session-facts">
					{stat.newSteps.length > 0 && <>Reached: {stat.newSteps.join(" → ")}. </>}
					{stat.checks > 0 && <>Checks: {stat.correct} of {stat.checks} right. </>}
					{stat.warmup && <>Opened with a warm-up.</>}
				</p>
			)}
			{page.skipped ? (
				<p className="mt-2 text-sm text-muted-foreground">This session was closed without notes.</p>
			) : (
				<>
					{page.summary && <p className="mt-1.5 text-sm leading-relaxed text-foreground">{page.summary}</p>}
					{page.concepts.length > 0 && (
						<Section title={NOTE_HEADINGS.learned}>
							<ol className="mt-1 space-y-2 text-sm leading-relaxed text-foreground">
								{page.concepts.map((c) => (
									<li key={c.n}>
										<strong>
											{c.n}. {c.title}
										</strong>{" "}
										— {c.body}
										{c.refs.length > 0 && <span className="text-xs text-muted-foreground"> (builds on {c.refs.join(", ")})</span>}
									</li>
								))}
							</ol>
						</Section>
					)}
					{page.rules.length > 0 && <Section title={NOTE_HEADINGS.rules}>{list(page.rules)}</Section>}
					{page.examples.length > 0 && <Section title={NOTE_HEADINGS.examples}>{list(page.examples)}</Section>}
					{page.stuck.length > 0 && <Section title={NOTE_HEADINGS.stuck}>{list(page.stuck)}</Section>}
					{page.misconceptions.length > 0 && (
						<Section title={NOTE_HEADINGS.misconceptions}>
							{list(page.misconceptions.map((m) => `I believed: ${m.believed}${m.whyWrong ? ` — why it is wrong: ${m.whyWrong}` : ""} — correct: ${m.correct}`))}
						</Section>
					)}
					{page.corrections.length > 0 && <Section title={NOTE_HEADINGS.corrections}>{list(page.corrections.map((c) => `Concept ${c.corrects}: ${c.text}`))}</Section>}
					{page.open.length > 0 && <Section title={NOTE_HEADINGS.open}>{list(page.open)}</Section>}
					{page.own && <Section title={NOTE_HEADINGS.own}><p className="mt-1 text-sm leading-relaxed text-foreground">{page.own}</p></Section>}
				</>
			)}
		</article>
	);
}
