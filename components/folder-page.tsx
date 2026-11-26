"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderIcon, MapIcon, PlusIcon } from "lucide-react";
import { NotesDialog } from "@/components/notes-dialog";
import { RoadmapSetup } from "@/components/roadmap-setup";
import { notifyLibraryChanged, useLibrary } from "@/components/library";
import { useServerEvent } from "@/components/server-events";
import { TopBar } from "@/components/top-bar";
import { timeAgo } from "@/components/sidebar";
import { cn } from "@/lib/utils";
import { folderSummaryLine, sameFolder, type RoadmapFolderStatus, type SessionCard } from "@/src/core";

/**
 * A FOLDER'S OVERVIEW: the home of one course or project. One card per session
 * — what it is (tags, the plan's own steps), where you are (progress, exam
 * result), and what you wrote down (the latest notes line) — with the doors you
 * need: open it, read its notes, warm up. Derived on the server from data the
 * app already keeps; this page only draws it.
 */

interface Overview {
	folder: string;
	cards: SessionCard[];
}

function statusChip(card: SessionCard): { text: string; tone: "done" | "warn" | "plain" } {
	if (card.kind === "practice") return { text: "Practice", tone: "plain" };
	const c = card.completion;
	if (!c) return { text: "In progress", tone: "plain" };
	if (c.status === "completed" && c.best) return { text: `Completed · ${c.best.grade} ${c.best.percent}%`, tone: "done" };
	if (c.status === "not-passed" && c.best) return { text: `Exam not passed · ${c.best.grade} ${c.best.percent}%`, tone: "warn" };
	if (c.status === "ready") return { text: "All plan clear", tone: "plain" };
	return { text: "In progress", tone: "plain" };
}

export function FolderPage({ name }: { name: string }) {
	const router = useRouter();
	const [data, setData] = useState<Overview | null>(null);
	const [notesFor, setNotesFor] = useState<string | null>(null);
	const [roadmap, setRoadmap] = useState<RoadmapFolderStatus | null>(null);
	const [confirmingRoadmap, setConfirmingRoadmap] = useState(false);
	const [roadmapBusy, setRoadmapBusy] = useState(false);
	const [roadmapError, setRoadmapError] = useState<string | null>(null);
	const { library } = useLibrary(true);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/folders/${encodeURIComponent(name)}/overview`, { cache: "no-store" });
			if (res.ok) setData((await res.json()) as Overview);
		} catch {
			// keep the last view
		}
	}, [name]);

	const refreshRoadmap = useCallback(async () => {
		try {
			const res = await fetch(`/api/folders/${encodeURIComponent(name)}/roadmap`, { cache: "no-store" });
			if (res.ok) setRoadmap(((await res.json()) as { roadmap: RoadmapFolderStatus }).roadmap);
		} catch {
			// keep the last view
		}
	}, [name]);

	useEffect(() => {
		void refresh();
		void refreshRoadmap();
	}, [refresh, refreshRoadmap]);

	/** POST = make this a roadmap folder (restores a saved one); DELETE = back to regular. */
	const changeRoadmapType = useCallback(
		async (method: "POST" | "DELETE") => {
			setRoadmapBusy(true);
			setRoadmapError(null);
			try {
				const res = await fetch(`/api/folders/${encodeURIComponent(name)}/roadmap`, { method });
				const body = (await res.json().catch(() => ({}))) as { roadmap?: RoadmapFolderStatus; error?: string };
				if (!res.ok || !body.roadmap) throw new Error(body.error ?? `Could not change the folder (${res.status})`);
				setRoadmap(body.roadmap);
				setConfirmingRoadmap(false);
				notifyLibraryChanged();
			} catch (cause) {
				setRoadmapError(cause instanceof Error ? cause.message : "Could not change the folder.");
			} finally {
				setRoadmapBusy(false);
			}
		},
		[name],
	);
	useServerEvent("chats-changed", () => void refresh());
	useServerEvent("notes-changed", () => void refresh());
	useServerEvent("record-changed", () => void refresh());
	useServerEvent("turn-settled", () => void refresh());

	const files = (library?.files ?? []).filter((f) => sameFolder(f.folder, name));
	const cards = data?.cards ?? [];
	const title = data?.folder ?? name;

	const newSessionHere = () => {
		try {
			window.localStorage.setItem("lh:new-session-folder", title);
		} catch {
			/* the draft simply opens unfiled */
		}
		router.push("/chat/new");
	};

	return (
		<div className="flex h-dvh flex-col" data-testid="folder-page">
			<TopBar>
				<FolderIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
				<h1 className="min-w-0 flex-1 truncate font-title text-3xl tracking-tight">{title}</h1>
				{roadmap?.type === "roadmap" && (
					<span data-testid="folder-roadmap-badge" className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
						Roadmap folder
					</span>
				)}
				{roadmap?.type === "regular" && !confirmingRoadmap && (
					<button
						type="button"
						onClick={() => setConfirmingRoadmap(true)}
						data-testid="folder-make-roadmap"
						className="lh-no-drag flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
					>
						<MapIcon className="size-3.5" aria-hidden />
						Make this a roadmap folder
					</button>
				)}
				<button
					type="button"
					onClick={newSessionHere}
					data-testid="folder-new-session"
					className="lh-no-drag flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
				>
					<PlusIcon className="size-3.5" aria-hidden />
					New session here
				</button>
			</TopBar>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-3xl px-6 py-6">
					{roadmap?.type === "regular" && confirmingRoadmap && (
						<RoadmapConvertCard
							saved={roadmap.hasSavedRoadmap}
							busy={roadmapBusy}
							error={roadmapError}
							onConfirm={() => void changeRoadmapType("POST")}
							onCancel={() => {
								setConfirmingRoadmap(false);
								setRoadmapError(null);
							}}
						/>
					)}
					{roadmap?.type === "roadmap" && (
						<RoadmapSetup name={name} busy={roadmapBusy} error={roadmapError} onDetach={() => void changeRoadmapType("DELETE")} />
					)}
					{data === null ? (
						<p className="text-sm text-muted-foreground">Loading…</p>
					) : (
						<>
							<p className="text-sm text-muted-foreground" data-testid="folder-summary">
								{folderSummaryLine(cards, files.length)}
							</p>
							{files.length > 0 && (
								<p className="mt-1 truncate text-xs text-muted-foreground" data-testid="folder-files-line">
									Files: {files.map((f) => f.name).join(" · ")}
								</p>
							)}
							{cards.length === 0 ? (
								<p className="mt-8 text-sm text-muted-foreground">No sessions in this folder yet. Drag one in from the sidebar, or start a new one here.</p>
							) : (
								<div className="mt-4 space-y-3">
									{cards.map((card) => (
										<SessionCardView key={card.id} card={card} onReadNotes={() => setNotesFor(card.id)} />
									))}
								</div>
							)}
						</>
					)}
				</div>
			</div>
			{notesFor && <NotesDialog chatId={notesFor} open onClose={() => setNotesFor(null)} />}
		</div>
	);
}

/** Asks before converting: what changes, what doesn't. */
function RoadmapConvertCard({ saved, busy, error, onConfirm, onCancel }: { saved: boolean; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
	return (
		<section data-testid="folder-roadmap-confirm" className="mb-4 rounded-xl border border-border bg-card px-4 py-3.5">
			<h2 className="text-sm font-medium text-foreground">{saved ? "Restore this folder's roadmap?" : "Make this a roadmap folder?"}</h2>
			<p className="mt-1 text-sm leading-relaxed text-muted-foreground">
				{saved
					? "This folder had a roadmap before. Its saved roadmap, books and progress come back exactly as you left them."
					: "The folder becomes dedicated to learning one subject from a roadmap and textbooks you add. You'll set that up here, one step at a time."}{" "}
				Sessions already in this folder stay as they are, and you can turn it back into a regular folder at any time — nothing is deleted.
			</p>
			{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
			<div className="mt-3 flex gap-2">
				<button
					type="button"
					disabled={busy}
					onClick={onConfirm}
					data-testid="folder-roadmap-confirm-yes"
					className="rounded-sm bg-foreground px-2.5 py-1 text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-50"
				>
					{saved ? "Restore roadmap folder" : "Make roadmap folder"}
				</button>
				<button type="button" disabled={busy} onClick={onCancel} className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50">
					Cancel
				</button>
			</div>
		</section>
	);
}

function SessionCardView({ card, onReadNotes }: { card: SessionCard; onReadNotes: () => void }) {
	const chip = statusChip(card);
	const pct = card.progress && card.progress.total > 0 ? Math.round((card.progress.covered / card.progress.total) * 100) : 0;
	const btn = "rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent";
	return (
		<article data-testid="folder-card" data-session-id={card.id} className="rounded-xl border border-border bg-card px-4 py-3.5">
			<div className="flex items-start gap-3">
				<Link href={`/chat/${card.id}`} className="min-w-0 flex-1 truncate font-prose text-base text-foreground hover:underline" data-testid="folder-card-title">
					{card.title}
				</Link>
				{card.closed && <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">Closed</span>}
				<span
					data-testid="folder-card-status"
					className={cn(
						"shrink-0 rounded-md border px-2 py-0.5 text-[11px]",
						chip.tone === "done" && "border-primary/50 text-foreground",
						chip.tone === "warn" && "border-destructive/50 text-foreground",
						chip.tone === "plain" && "border-border text-muted-foreground",
					)}
				>
					{chip.text}
				</span>
			</div>

			<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
				{card.tags.map((t) => (
					<span key={t} className="rounded-md border border-border/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
						#{t}
					</span>
				))}
				<span className="ml-auto text-[11px] text-muted-foreground">Last studied {timeAgo(card.updatedAt)}</span>
			</div>

			{card.material.titles.length > 0 && (
				<div className="mt-3" data-testid="folder-card-material">
					<div className="text-[11px] uppercase tracking-wider text-muted-foreground">Material</div>
					<div className="mt-0.5 text-sm leading-relaxed text-foreground">
						{card.material.titles.join(" → ")}
						{card.material.more > 0 && <span className="text-muted-foreground"> · +{card.material.more} more</span>}
					</div>
				</div>
			)}

			{card.progress && (
				<div className="mt-3 flex items-center gap-3" data-testid="folder-card-progress">
					<div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
						<div className="h-full bg-foreground" style={{ width: `${pct}%` }} />
					</div>
					<span className="text-xs text-muted-foreground">
						{card.progress.covered} of {card.progress.total} steps
					</span>
				</div>
			)}

			<div className="mt-3" data-testid="folder-card-notes">
				<div className="text-[11px] uppercase tracking-wider text-muted-foreground">Notes{card.notes.sessions > 0 ? ` · ${card.notes.sessions} session${card.notes.sessions === 1 ? "" : "s"}` : ""}</div>
				<div className={cn("mt-0.5 text-sm leading-relaxed", card.notes.latest ? "text-foreground" : "text-muted-foreground")}>
					{card.notes.latest ?? (card.notes.sessions > 0 ? "Closed without notes so far." : "No notes yet.")}
				</div>
			</div>

			<div className="mt-3 flex flex-wrap gap-2">
				<Link href={`/chat/${card.id}`} className={btn} data-testid="folder-card-open">
					Open session
				</Link>
				{card.notes.sessions > 0 && (
					<button type="button" onClick={onReadNotes} className={btn} data-testid="folder-card-notes-button">
						Read notes
					</button>
				)}
				{card.kind === "teach" && card.progress !== null && card.progress.covered > 0 && (
					<Link href={`/chat/${card.id}?warmup=1`} className={btn} data-testid="folder-card-warmup">
						Warm up
					</Link>
				)}
			</div>
		</article>
	);
}
