"use client";

import { useCallback, useEffect, useState } from "react";
import { LockIcon } from "lucide-react";

/**
 * THE START-SESSION PANEL: shown while a session is CLOSED (its newest message
 * is the closed marker). Instead of dropping the learner straight back into the
 * question that was waiting, it asks how to start the next session:
 *   - "Start with warm-up" (when one is possible): the teacher recaps what was
 *     studied and asks a few recall questions; the waiting check is paused and
 *     posed again afterwards;
 *   - "Start without warm-up": the waiting question simply comes back.
 * Typing into the composer also starts the next session (the check is paused).
 */
export function SessionClosedPanel({ chatId, canStart, onWarmup }: { chatId: string; canStart: boolean; onWarmup: () => void }) {
	const [warmupAvailable, setWarmupAvailable] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${chatId}/warmup`);
				if (res.ok && live) setWarmupAvailable(((await res.json()) as { available?: boolean }).available === true);
			} catch {
				// no warm-up offered
			}
		})();
		return () => {
			live = false;
		};
	}, [chatId]);

	const startPlain = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/chats/${chatId}/session/start`, { method: "POST" });
			if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Could not start (${res.status})`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not start the session.");
			setBusy(false);
		}
	}, [chatId]);

	return (
		<div data-testid="session-closed-panel" className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 text-xs">
			<LockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			<div className="min-w-0 flex-1">
				<div className="text-foreground">This session is closed.</div>
				<div className="truncate text-muted-foreground">
					{warmupAvailable ? "Start the next one with a short warm-up, or pick up your waiting question." : "Start the next one to pick up where you left off."}
				</div>
				{error && <div className="text-destructive">{error}</div>}
			</div>
			{warmupAvailable && (
				<button
					type="button"
					disabled={!canStart || busy}
					onClick={onWarmup}
					data-testid="start-with-warmup"
					className="shrink-0 rounded-sm bg-foreground px-2.5 py-1 text-background transition-opacity hover:opacity-90 disabled:opacity-50"
				>
					Start with warm-up
				</button>
			)}
			<button
				type="button"
				disabled={busy}
				onClick={() => void startPlain()}
				data-testid="start-without-warmup"
				className="shrink-0 rounded-sm border border-border px-2.5 py-1 transition-colors hover:bg-accent disabled:opacity-50"
			>
				{warmupAvailable ? "Start without warm-up" : "Start session"}
			</button>
		</div>
	);
}
