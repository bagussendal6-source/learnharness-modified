"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileTextIcon, FolderIcon, MonitorUpIcon, PaperclipIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { joinSources, sourceName, splitSources } from "@/components/source-lines";
import { FILE_ACCEPT } from "@/components/library-panel";
import { formatBytes, notifyLibraryChanged, useLibrary } from "@/components/library";
import { fuzzyScore, groupByFolder, type LibraryFile } from "@/src/core";

/**
 * The paperclip: a small menu with two ways to attach a source —
 *  - "From computer": the native Finder dialog; the bytes upload to
 *    /api/sources (and are kept in the library, so they can be reused);
 *  - "From stored files": the library of files already uploaded (per
 *    folder, searchable) — no re-upload.
 * Either way the result is the same "Source file: <saved path>" line on the
 * message, so the teacher's fs/pdf tools read it and nothing else changes.
 * Shared by the session composer and the new-session page.
 */
export function AttachSourceButton({ value, onChange, className }: { value: string; onChange: (next: string) => void; className?: string }) {
	const fileInput = useRef<HTMLInputElement>(null);
	const root = useRef<HTMLSpanElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	// The menu is portaled to <body> (the composer shells are overflow-hidden
	// and would clip an upward-opening menu), so it is positioned from the
	// button's rect: bottom-left aligned, opening upward.
	const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
	const valueRef = useRef(value);
	valueRef.current = value;
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [menu, setMenu] = useState<"closed" | "menu" | "stored">("closed");
	const [query, setQuery] = useState("");
	const { library } = useLibrary(menu === "stored");

	// Outside click / Esc closes (Esc claimed, like the other menus).
	useEffect(() => {
		if (menu === "closed") return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (!root.current?.contains(target) && !menuRef.current?.contains(target)) setMenu("closed");
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setMenu("closed");
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [menu]);

	useLayoutEffect(() => {
		if (menu === "closed") return;
		const place = () => {
			const rect = root.current?.getBoundingClientRect();
			if (!rect) return;
			const width = 288; // w-72
			setPos({
				left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
				bottom: window.innerHeight - rect.top + 4,
			});
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [menu]);

	function append(added: { path: string; name: string }[]) {
		const { text, files: existing } = splitSources(valueRef.current);
		const fresh = added.filter((a) => !existing.some((e) => e.path === a.path));
		onChange(joinSources(text, [...existing, ...fresh]));
	}

	async function attach(files: FileList | null) {
		if (!files || files.length === 0) return;
		setUploading(true); setError(null);
		try {
			const body = new FormData();
			for (const file of Array.from(files)) body.append("files", file);
			const response = await fetch("/api/sources", { method: "POST", body });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error ?? "Upload failed.");
			append((result.files as { name: string; path: string }[]).map((f) => ({ path: f.path, name: sourceName(f.path) })));
			notifyLibraryChanged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Upload failed.");
		} finally {
			setUploading(false);
			if (fileInput.current) fileInput.current.value = "";
		}
	}

	const q = query.trim();
	const files = (library?.files ?? []).filter((f) => !q || fuzzyScore(q, f.name, f.folder ?? "") !== null);
	const groups = groupByFolder<LibraryFile>(files, library?.folders ?? []).filter((g) => g.items.length > 0);
	const row = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent";

	return <span ref={root} className="relative flex shrink-0">
		<input ref={fileInput} type="file" multiple accept={FILE_ACCEPT} className="hidden" data-testid="composer-file-input" onChange={(e) => void attach(e.target.files)} />
		<button
			type="button"
			aria-label="Attach source files"
			aria-haspopup="menu"
			aria-expanded={menu !== "closed"}
			title={error ?? "Attach a PDF, PowerPoint, Word or notes file as a source"}
			data-testid="composer-attach"
			disabled={uploading}
			onClick={() => { setError(null); setMenu((m) => (m === "closed" ? "menu" : "closed")); }}
			className={cn("flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40", error && "text-red-400", className)}
		>
			<PaperclipIcon className={cn("size-4", uploading && "animate-pulse")} />
		</button>
		{menu !== "closed" && pos && createPortal(
			<div ref={menuRef} data-testid="attach-menu" role="menu" style={{ position: "fixed", left: pos.left, bottom: pos.bottom }} className="z-50 w-72 rounded-xl border bg-card p-1.5 shadow-xl">
				{menu === "menu" ? <>
					<button type="button" role="menuitem" data-testid="attach-from-computer" className={row} onClick={() => { setMenu("closed"); fileInput.current?.click(); }}>
						<MonitorUpIcon className="size-3.5 text-muted-foreground" /> From computer…
					</button>
					<button type="button" role="menuitem" data-testid="attach-from-stored" className={row} onClick={() => setMenu("stored")}>
						<FolderIcon className="size-3.5 text-muted-foreground" /> From stored files…
					</button>
				</> : <>
					<input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search stored files…"
						aria-label="Search stored files"
						data-testid="attach-search"
						className="mb-1 w-full rounded-sm border border-border bg-background px-2 py-1 text-xs outline-none"
					/>
					<div className="max-h-64 overflow-y-auto" data-testid="attach-stored-list">
						{!library ? <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
							: groups.length === 0 ? <div className="px-2 py-3 text-xs text-muted-foreground">{q ? "No files match." : "No stored files yet — add some from a folder in the sidebar, or attach from your computer."}</div>
							: groups.map((g) => <div key={g.folder ?? "__unfiled"}>
								<div className="px-2.5 pb-0.5 pt-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">{g.folder ?? "Unfiled"}</div>
								{g.items.map((f) => <button key={f.id} type="button" role="menuitem" data-testid="attach-stored-file" title={f.name} className={row} onClick={() => { append([{ path: f.path, name: f.name }]); setMenu("closed"); }}>
									<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate">{f.name}</span>
									<span className="shrink-0 text-[11px] text-muted-foreground">{formatBytes(f.size)}</span>
								</button>)}
							</div>)}
					</div>
				</>}
			</div>,
			document.body,
		)}
	</span>;
}
