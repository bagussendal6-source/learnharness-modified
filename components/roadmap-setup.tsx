"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RoadmapSetupView } from "@/src/core";

/**
 * A ROADMAP FOLDER'S SETUP — the one-time flow inside the folder:
 *   1. your roadmap  (a file or pasted text; a program reads its structure
 *      exactly — anything it can't read is listed and nothing is saved)
 *   2. your books    (PDFs; read once and kept as an index in the folder)
 *   3. review        (every unit's page range checked against the books' own
 *      tables of contents; the learner approves before learning starts)
 *
 * Files go to the server as raw bytes (no upload size limit); the server owns
 * every rule — this component only draws the view it is given.
 */

interface Problem {
	message: string;
	lines: string[];
}

const btn = "rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50";

async function send(url: string, init: RequestInit): Promise<{ ok: true } | { ok: false; problem: Problem }> {
	try {
		const res = await fetch(url, init);
		if (res.ok) return { ok: true };
		const body = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[] };
		return { ok: false, problem: { message: body.error ?? `Request failed (${res.status}).`, lines: body.problems ?? [] } };
	} catch {
		return { ok: false, problem: { message: "Could not reach the app.", lines: [] } };
	}
}

export function RoadmapSetup({ name, busy, error, onDetach }: { name: string; busy: boolean; error: string | null; onDetach: () => void }) {
	const [view, setView] = useState<RoadmapSetupView | null>(null);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [working, setWorking] = useState<string | null>(null);
	const [pasteOpen, setPasteOpen] = useState(false);
	const [pasteText, setPasteText] = useState("");
	const [openStages, setOpenStages] = useState<Set<string>>(new Set());
	const roadmapInput = useRef<HTMLInputElement>(null);
	const bookInput = useRef<HTMLInputElement>(null);
	const base = `/api/folders/${encodeURIComponent(name)}/roadmap`;

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`${base}/setup`, { cache: "no-store" });
			if (res.ok) setView(((await res.json()) as { setup: RoadmapSetupView }).setup);
		} catch {
			// keep the last view
		}
	}, [base]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const run = async (label: string, action: () => Promise<{ ok: true } | { ok: false; problem: Problem }>) => {
		setWorking(label);
		setProblem(null);
		const result = await action();
		if (!result.ok) setProblem(result.problem);
		await refresh();
		setWorking(null);
		return result.ok;
	};

	const uploadRoadmapFile = (file: File) =>
		run(`Reading ${file.name}…`, () => send(`${base}/doc`, { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file }));

	const uploadRoadmapText = async () => {
		const ok = await run("Reading the roadmap…", () => send(`${base}/doc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: pasteText }) }));
		if (ok) {
			setPasteOpen(false);
			setPasteText("");
		}
	};

	const uploadBooks = async (files: File[]) => {
		for (const file of files) {
			const ok = await run(`Reading ${file.name} — a big book takes a few seconds…`, () => send(`${base}/books/upload`, { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file }));
			if (!ok) break;
		}
	};

	const approve = () => run("Approving…", () => send(`${base}/approve`, { method: "POST" }));
	const disabled = working !== null || busy;
	const active = view?.state === "active";
	const toggleStage = (id: string) =>
		setOpenStages((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	return (
		<section data-testid="folder-roadmap-setup" className="mb-4 rounded-xl border border-border bg-card px-4 py-3.5">
			<div className="flex items-center gap-2">
				<h2 className="text-sm font-medium text-foreground">Roadmap setup</h2>
				{active && <span className="rounded-md border border-primary/50 px-1.5 py-0.5 text-[11px] text-foreground">Approved</span>}
			</div>

			{/* 1 — the roadmap */}
			<Step n={1} title="Your roadmap" done={view?.roadmap != null}>
				{view?.roadmap ? (
					<p className="text-xs text-muted-foreground" data-testid="roadmap-summary">
						{view.roadmap.units} units in {view.roadmap.stages.length} stage{view.roadmap.stages.length === 1 ? "" : "s"} read from your roadmap.
					</p>
				) : (
					<p className="text-xs text-muted-foreground">A PDF, .txt or .md file, or pasted text — the list of units you want to learn, each with its book pages.</p>
				)}
				<div className="mt-2 flex flex-wrap gap-2">
					<button type="button" disabled={disabled} className={btn} onClick={() => roadmapInput.current?.click()} data-testid="roadmap-choose-file">
						{view?.roadmap ? "Replace roadmap file" : "Choose roadmap file"}
					</button>
					<button type="button" disabled={disabled} className={btn} onClick={() => setPasteOpen((v) => !v)}>
						Paste text instead
					</button>
					<input
						ref={roadmapInput}
						type="file"
						accept=".pdf,.txt,.md,.markdown"
						className="hidden"
						data-testid="roadmap-file-input"
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (file) void uploadRoadmapFile(file);
						}}
					/>
				</div>
				{pasteOpen && (
					<div className="mt-2">
						<textarea
							value={pasteText}
							onChange={(e) => setPasteText(e.target.value)}
							rows={6}
							placeholder="Paste your roadmap here…"
							className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
						/>
						<button type="button" disabled={disabled || pasteText.trim() === ""} className={cn(btn, "mt-1")} onClick={() => void uploadRoadmapText()}>
							Read this text
						</button>
					</div>
				)}
			</Step>

			{/* 2 — the books */}
			<Step n={2} title="Your books" done={view != null && view.books.length > 0 && view.books.every((b) => b.file !== null && !b.ambiguous)}>
				{view && view.books.length > 0 ? (
					<ul className="space-y-1" data-testid="roadmap-books">
						{view.books.map((b) => (
							<li key={b.key} className="flex items-baseline gap-2 text-xs">
								{b.file && !b.ambiguous ? <CheckIcon className="size-3.5 shrink-0 translate-y-0.5 text-primary" aria-hidden /> : <XIcon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />}
								<span className="text-foreground">{b.label}</span>
								<span className="min-w-0 truncate text-muted-foreground">
									{b.ambiguous ? "more than one added file fits — remove the extra one" : b.file ? `${b.file.split(" -- ")[0]} · ${b.pages} pages` : "not added yet"}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-muted-foreground">{view?.roadmap ? "Your roadmap names no books." : "Add your roadmap first, or add the books now — they are matched to the roadmap by name."}</p>
				)}
				{view && view.otherBooks.length > 0 && (
					<p className="mt-1 text-[11px] text-muted-foreground">Added but not in the roadmap: {view.otherBooks.map((b) => b.file.split(" -- ")[0]).join(" · ")}</p>
				)}
				<div className="mt-2">
					<button type="button" disabled={disabled} className={btn} onClick={() => bookInput.current?.click()} data-testid="roadmap-add-books">
						Add book PDFs
					</button>
					<span className="ml-2 text-[11px] text-muted-foreground">Each book is read once and kept in this folder.</span>
					<input
						ref={bookInput}
						type="file"
						accept=".pdf,application/pdf"
						multiple
						className="hidden"
						data-testid="roadmap-book-input"
						onChange={(e) => {
							const files = [...(e.target.files ?? [])];
							e.target.value = "";
							if (files.length > 0) void uploadBooks(files);
						}}
					/>
				</div>
			</Step>

			{/* 3 — review and approve */}
			<Step n={3} title="Review the page mapping" done={active}>
				{view?.roadmap ? (
					<>
						<p className="text-xs text-muted-foreground" data-testid="roadmap-checks">
							Every unit's pages are checked against the book's own table of contents: {view.counts.ok} match chapter boundaries
							{view.counts.pending > 0 && `, ${view.counts.pending} waiting for their book`}
							{view.counts.warn > 0 && `, ${view.counts.warn} to look at`}
							{view.counts.error > 0 && `, ${view.counts.error} can't be right`}.
						</p>
						<div className="mt-2 space-y-1">
							{view.roadmap.stages.map((stage) => {
								const open = openStages.has(stage.id);
								const flagged = stage.units.filter((u) => u.check !== "ok").length;
								return (
									<div key={stage.id}>
										<button type="button" onClick={() => toggleStage(stage.id)} className="flex w-full items-center gap-1.5 text-left text-xs text-foreground hover:underline">
											<ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
											<span>
												{stage.id !== "-" && `Stage ${stage.id} · `}
												{stage.title}
											</span>
											<span className="text-muted-foreground">
												· {stage.units.length} units{stage.gate > 0 ? ` · gate of ${stage.gate} tasks` : ""}
												{flagged > 0 ? ` · ${flagged} to look at` : ""}
											</span>
										</button>
										{open && (
											<ul className="mt-1 space-y-1 pl-5">
												{stage.units.map((u) => (
													<li key={u.id} className="text-xs" data-testid="roadmap-unit">
														<div className="flex items-baseline gap-2">
															{u.check === "ok" ? (
																<CheckIcon className="size-3.5 shrink-0 translate-y-0.5 text-primary" aria-hidden />
															) : u.check === "pending" ? (
																<XIcon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />
															) : (
																<AlertTriangleIcon className="size-3.5 shrink-0 translate-y-0.5 text-destructive" aria-hidden />
															)}
															<span className="shrink-0 text-muted-foreground">{u.id}</span>
															<span className="min-w-0 truncate text-foreground">{u.title}</span>
															{u.flags.map((f) => (
																<span key={f} className="shrink-0 rounded border border-border/70 px-1 text-[10px] text-muted-foreground">
																	{f}
																</span>
															))}
															<span className="ml-auto shrink-0 text-muted-foreground">{u.pages}</span>
														</div>
														{u.notes.map((n) => (
															<div key={n} className={cn("pl-6 text-[11px]", u.check === "pending" ? "text-muted-foreground" : "text-destructive")}>
																{n}
															</div>
														))}
													</li>
												))}
											</ul>
										)}
									</div>
								);
							})}
						</div>
						{!active && (
							<div className="mt-3">
								{view.blockers.length > 0 && (
									<ul className="mb-2 space-y-0.5 text-xs text-muted-foreground" data-testid="roadmap-blockers">
										{view.blockers.map((b) => (
											<li key={b}>• {b}</li>
										))}
									</ul>
								)}
								<button type="button" disabled={disabled || !view.canApprove} onClick={() => void approve()} data-testid="roadmap-approve" className="rounded-sm bg-foreground px-2.5 py-1 text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-40">
									Approve this mapping
								</button>
							</div>
						)}
					</>
				) : (
					<p className="text-xs text-muted-foreground">Appears once your roadmap is read.</p>
				)}
			</Step>

			{working && (
				<p className="mt-2 text-xs text-muted-foreground" role="status" data-testid="roadmap-working">
					{working}
				</p>
			)}
			{(problem || error) && (
				<div className="mt-2 text-xs text-destructive" role="alert" data-testid="roadmap-problem">
					<div>{problem?.message ?? error}</div>
					{problem?.lines.map((l) => (
						<div key={l} className="pl-3">
							• {l}
						</div>
					))}
				</div>
			)}

			<div className="mt-3 border-t border-border pt-3">
				<button type="button" disabled={disabled} onClick={onDetach} data-testid="folder-roadmap-detach" className={btn}>
					Turn back into a regular folder
				</button>
				<span className="ml-2 text-[11px] text-muted-foreground">Keeps your sessions, books and roadmap data.</span>
			</div>
		</section>
	);
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
	return (
		<div className="mt-3 flex gap-3">
			<span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]", done ? "border-primary/60 text-primary" : "border-border text-muted-foreground")}>
				{done ? <CheckIcon className="size-3" aria-hidden /> : n}
			</span>
			<div className="min-w-0 flex-1">
				<div className="text-sm text-foreground">{title}</div>
				{children}
			</div>
		</div>
	);
}
