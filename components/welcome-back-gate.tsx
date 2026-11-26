"use client";

import { useCallback, useEffect, useState } from "react";
import { FlameIcon } from "lucide-react";
import { useServerEvent } from "@/components/server-events";

/**
 * THE WELCOME-BACK GATE: on opening a teaching session that has been idle for a
 * few days (the server decides — core/warmup.ts: 3 days, a plan with at least
 * one check, no question waiting), offer a short warm-up before continuing.
 * "Warm up" sends the bare `warmup` input; the server builds the brief. "Skip"
 * just hides the strip. Renders nothing when no warm-up is offered — and
 * disappears by itself once the session has activity again (the idle gap closes).
 */

interface Offer {
	offer: boolean;
	idleDays: number;
	plan: { covered: { id: string; title: string }[]; stoppedAt: { title: string } | null; items: { nodeId: string; title: string; reason: string }[] };
}

export function WelcomeBackGate({ chatId, canStart, onStart }: { chatId: string; canStart: boolean; onStart: () => void }) {
	const [data, setData] = useState<Offer | null>(null);
	const [dismissed, setDismissed] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}/warmup`);
			if (res.ok) setData((await res.json()) as Offer);
		} catch {
			// silent: no gate
		}
	}, [chatId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);
	// Any turn ends the idle gap — refetch so the strip clears itself.
	useServerEvent("turn-started", (p) => {
		if (p.chatId === chatId) void refresh();
	});
	useServerEvent("turn-settled", (p) => {
		if (p.chatId === chatId) void refresh();
	});

	if (!data?.offer || dismissed) return null;
	const titles = data.plan.items.map((i) => i.title);
	return (
		<div data-testid="welcome-back-gate" className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-xs">
			<FlameIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			<div className="min-w-0 flex-1">
				<div className="truncate text-foreground" data-testid="welcome-back-line">
					Welcome back — {data.idleDays} days since you last studied this. Warm up before continuing?
				</div>
				<div className="truncate text-muted-foreground">
					We’ll recap{data.plan.stoppedAt ? ` up to “${data.plan.stoppedAt.title}”` : ""} and go back over: {titles.join(" · ")}
				</div>
			</div>
			<button
				type="button"
				disabled={!canStart}
				// No local dismissal here: the strip clears itself when the turn starts
				// (the idle gap closes → the offer refetches false), and if the send is
				// refused (no model configured yet) the offer stays for another try.
				onClick={onStart}
				data-testid="welcome-back-start"
				className="shrink-0 rounded-sm bg-foreground px-2.5 py-1 text-background transition-opacity hover:opacity-90 disabled:opacity-50"
			>
				Warm up
			</button>
			<button type="button" onClick={() => setDismissed(true)} data-testid="welcome-back-skip" className="shrink-0 rounded-sm border border-border px-2.5 py-1 transition-colors hover:bg-accent">
				Continue without
			</button>
		</div>
	);
}
