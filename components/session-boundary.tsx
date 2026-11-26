"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { cn } from "@/lib/utils";

/**
 * The transcript's session-boundary label: ONE compact line, no rules or
 * dividers — "Session closed · notes written" / "Session closed · no notes" /
 * "Session started". UI-only; the teacher never reads these markers.
 */
export interface SessionBoundaryData {
	kind: "session-closed" | "session-started";
	pageNumber?: number;
	notes?: boolean;
}

export function SessionBoundary({ data }: { data: SessionBoundaryData }) {
	const label =
		data.kind === "session-started"
			? "Session started"
			: `Session ${data.pageNumber ?? ""} closed · ${data.notes ? "notes written" : "no notes"}`.replace("Session  closed", "Session closed");
	return (
		<div data-testid="session-boundary" data-kind={data.kind} className="my-2 text-center text-[11px] uppercase tracking-wider text-muted-foreground/70">
			{label}
		</div>
	);
}

/** The line at the top of session 2+: this page continues the previous one. */
export function ContinuingFrom({ from, onView }: { from: number; onView: () => void }) {
	return (
		<div data-testid="continuing-from" className="text-center text-xs text-muted-foreground">
			Continuing from Session {from} ·{" "}
			<button type="button" onClick={onView} className="underline-offset-2 hover:text-foreground hover:underline">
				view it
			</button>
		</div>
	);
}

/** The header's "Session 2 ▾": every finished session is a page of its own. */
export function SessionPicker({
	current,
	viewing,
	finished,
	onPick,
}: {
	current: number;
	viewing: number;
	finished: { session: number; rows: number; notes: boolean }[];
	onPick: (session: number) => void;
}) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (anchorRef.current?.contains(t)) return;
			setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	const rows = [...finished.map((f) => ({ session: f.session, text: `${f.rows} message${f.rows === 1 ? "" : "s"} · ${f.notes ? "notes written" : "no notes"}` })), { session: current, text: "current" }];
	return (
		<>
			<button
				type="button"
				ref={(el) => {
					anchorRef.current = el;
				}}
				data-testid="session-picker"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				Session {viewing}
				<ChevronDownIcon className="size-3" aria-hidden />
			</button>
			{open && (
				<MenuShell anchorRef={anchorRef} testid="session-picker-menu" preferredSide="down" menuClass="flex w-60 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
					{rows.map((r) => (
						<button
							key={r.session}
							type="button"
							data-testid={`session-pick-${r.session}`}
							onClick={() => {
								setOpen(false);
								onPick(r.session);
							}}
							className={cn("flex items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent", r.session === viewing && "bg-accent")}
						>
							<span>Session {r.session}</span>
							<span className="ml-auto text-muted-foreground">{r.text}</span>
						</button>
					))}
				</MenuShell>
			)}
		</>
	);
}

/** In place of the composer while a FINISHED session is on screen: only the
 *  current session has a teacher, so this page is for reading. */
export function ReadOnlySessionBar({ session, onBack }: { session: number; onBack: () => void }) {
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-5">
			<div data-testid="read-only-bar" className="pointer-events-auto flex items-center gap-3 rounded-2xl border bg-card px-4 py-2.5 text-xs shadow-lg">
				<span className="text-muted-foreground">Session {session} · read-only</span>
				<button type="button" onClick={onBack} data-testid="back-to-current" className="rounded-sm bg-foreground px-2.5 py-1 text-background transition-opacity hover:opacity-90">
					Back to the current session
				</button>
			</div>
		</div>
	);
}
