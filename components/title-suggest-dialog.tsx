"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SparklesIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import type { ChatListItem } from "@/src/core";

/**
 * "Generate name" for a session whose title is still the raw first prompt.
 *
 * Single mode: asks the cheap model for a title from the conversation and
 * shows it for accept / edit / regenerate — nothing is saved until Accept
 * (the PUT stamps titleSource "manual", so the automatic namer never
 * touches it again).
 *
 * Bulk mode ("Name all untitled sessions"): fetches a suggestion for every
 * still-untitled session ONE AT A TIME (progress + cancel), then lists them
 * all for review. Only the rows left checked are applied; nothing is renamed
 * silently.
 */

type Row = { id: string; current: string; suggestion: string; checked: boolean };

async function fetchSuggestion(id: string, signal?: AbortSignal): Promise<string> {
	const res = await fetch(`/api/chats/${id}/title/suggest`, { method: "POST", signal });
	const body = (await res.json().catch(() => ({}))) as { title?: string; error?: string };
	if (!res.ok || !body.title) throw new Error(body.error ?? `Suggestion failed (${res.status})`);
	return body.title;
}

async function putTitle(id: string, title: string): Promise<void> {
	const res = await fetch(`/api/chats/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) throw new Error(`Rename failed (${res.status})`);
	window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title } }));
}

export function TitleSuggestDialog({
	chat,
	untitled,
	onClose,
	onDone,
}: {
	/** The session to name (single mode); null = closed. */
	chat: Pick<ChatListItem, "id" | "title"> | null;
	/** Every session still on its prompt title (the bulk candidates). */
	untitled: Pick<ChatListItem, "id" | "title">[];
	onClose: () => void;
	onDone: () => void;
}) {
	const [mode, setMode] = useState<"single" | "bulk">("single");
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [rows, setRows] = useState<Row[]>([]);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	const [skipped, setSkipped] = useState(0);
	const abortRef = useRef<AbortController | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});

	const suggestOne = useCallback(async (id: string) => {
		const ac = new AbortController();
		abortRef.current = ac;
		setBusy(true);
		setError(null);
		try {
			setDraft(await fetchSuggestion(id, ac.signal));
		} catch (cause) {
			if (!ac.signal.aborted) setError(cause instanceof Error ? cause.message : "Suggestion failed.");
		} finally {
			setBusy(false);
		}
	}, []);

	// Opening (or switching chat) resets and asks for a fresh single suggestion.
	useEffect(() => {
		if (!chat) return;
		setMode("single");
		setDraft("");
		setRows([]);
		setProgress(null);
		setSkipped(0);
		setError(null);
		void suggestOne(chat.id);
		return () => abortRef.current?.abort();
	}, [chat, suggestOne]);

	useEffect(() => {
		if (!chat) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				abortRef.current?.abort();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [chat, onClose]);

	if (!chat) return null;

	const acceptSingle = async () => {
		const title = draft.trim();
		if (!title) return;
		setBusy(true);
		setError(null);
		try {
			await putTitle(chat.id, title);
			onDone();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Rename failed.");
			setBusy(false);
		}
	};

	const startBulk = async () => {
		const ac = new AbortController();
		abortRef.current = ac;
		setMode("bulk");
		setRows([]);
		setSkipped(0);
		setError(null);
		setBusy(true);
		setProgress({ done: 0, total: untitled.length });
		let skippedCount = 0;
		for (let i = 0; i < untitled.length; i++) {
			if (ac.signal.aborted) break;
			const target = untitled[i]!;
			try {
				const suggestion = await fetchSuggestion(target.id, ac.signal);
				setRows((prev) => [...prev, { id: target.id, current: target.title, suggestion, checked: true }]);
			} catch {
				// An empty session or a model hiccup: skip it, keep going.
				if (!ac.signal.aborted) skippedCount++;
			}
			setProgress({ done: i + 1, total: untitled.length });
		}
		setSkipped(skippedCount);
		setBusy(false);
	};

	const applyBulk = async () => {
		const chosen = rows.filter((r) => r.checked && r.suggestion.trim() !== "");
		setBusy(true);
		setError(null);
		let failed = 0;
		for (const r of chosen) {
			try {
				await putTitle(r.id, r.suggestion.trim());
			} catch {
				failed++;
			}
		}
		if (failed > 0) {
			setError(`${failed} rename${failed === 1 ? "" : "s"} failed.`);
			setBusy(false);
			return;
		}
		onDone();
	};

	const stopBulk = () => abortRef.current?.abort();
	const checkedCount = rows.filter((r) => r.checked).length;
	const btn = "rounded-sm border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50";
	const primary = "rounded-sm bg-foreground px-3 py-1.5 text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-50";

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Generate session name"
				data-testid="title-suggest-dialog"
				onClick={(e) => e.stopPropagation()}
				className="w-[34rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
					<SparklesIcon className="size-3.5" aria-hidden="true" />
					{mode === "single" ? "Generate name" : "Name untitled sessions"}
				</h2>

				{mode === "single" ? (
					<>
						<div className="mt-1 truncate font-mono text-xs text-muted-foreground">Now: {chat.title}</div>
						<input
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							disabled={busy}
							placeholder={busy ? "Reading the session…" : "Suggested name"}
							data-testid="title-suggest-input"
							className="mt-3 w-full rounded-sm border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-muted-foreground/60"
						/>
						{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
						<div className="mt-4 flex items-center justify-between gap-2">
							{untitled.length > 1 ? (
								<button type="button" disabled={busy} onClick={() => void startBulk()} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50" data-testid="title-suggest-bulk">
									Name all {untitled.length} untitled sessions…
								</button>
							) : (
								<span />
							)}
							<div className="flex gap-2">
								<button type="button" disabled={busy} onClick={() => void suggestOne(chat.id)} className={btn}>Regenerate</button>
								<button type="button" onClick={onClose} className={btn}>Cancel</button>
								<button type="button" disabled={busy || draft.trim() === ""} onClick={() => void acceptSingle()} className={primary} data-testid="title-suggest-accept">Accept</button>
							</div>
						</div>
					</>
				) : (
					<>
						<p className="mt-1 text-xs text-muted-foreground">
							{busy && progress ? `Reading sessions… ${progress.done}/${progress.total}` : `${rows.length} suggestion${rows.length === 1 ? "" : "s"}${skipped > 0 ? ` · ${skipped} skipped (empty or failed)` : ""}. Nothing is renamed until you apply.`}
						</p>
						<ul className="mt-3 max-h-72 space-y-1.5 overflow-y-auto" data-testid="title-suggest-rows">
							{rows.map((r) => (
								<li key={r.id} className="flex items-start gap-2 rounded-sm border border-border/60 p-2">
									<input
										type="checkbox"
										checked={r.checked}
										disabled={busy}
										onChange={(e) => setRows((prev) => prev.map((p) => (p.id === r.id ? { ...p, checked: e.target.checked } : p)))}
										className="mt-1"
										aria-label={`Apply the new name for ${r.current}`}
									/>
									<div className="min-w-0 flex-1">
										<div className="truncate font-mono text-[11px] text-muted-foreground line-through">{r.current}</div>
										<input
											value={r.suggestion}
											disabled={busy}
											onChange={(e) => setRows((prev) => prev.map((p) => (p.id === r.id ? { ...p, suggestion: e.target.value } : p)))}
											className="mt-0.5 w-full rounded-sm border border-border bg-background px-2 py-1 text-xs outline-none focus:border-muted-foreground/60"
										/>
									</div>
								</li>
							))}
						</ul>
						{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
						<div className="mt-4 flex justify-end gap-2">
							{busy && progress && progress.done < progress.total ? (
								<button type="button" onClick={stopBulk} className={btn}>Stop</button>
							) : (
								<button type="button" disabled={busy} onClick={onClose} className={btn}>Cancel</button>
							)}
							<button type="button" disabled={busy || checkedCount === 0} onClick={() => void applyBulk()} className={primary} data-testid="title-suggest-apply">
								Apply {checkedCount}
							</button>
						</div>
					</>
				)}
			</div>
		</div>,
		document.body,
	);
}
