"use client";

import { useCallback, useEffect, useState } from "react";
import { FlameIcon } from "lucide-react";
import { useServerEvent } from "@/components/server-events";
import { Hint } from "@/components/ui/hint";

/**
 * The always-there "Warm up" button in a teaching session's header. The idle
 * gate (welcome-back-gate.tsx) only appears after a few days away; this is the
 * same warm-up on demand, available whenever the session has covered something
 * (the server decides — core/warmup.ts). Renders nothing until then.
 */
export function WarmupChip({ chatId, canStart, onStart }: { chatId: string; canStart: boolean; onStart: () => void }) {
	const [available, setAvailable] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}/warmup`);
			if (res.ok) setAvailable(((await res.json()) as { available?: boolean }).available === true);
		} catch {
			// silent: no chip
		}
	}, [chatId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);
	useServerEvent("turn-settled", (p) => {
		if (p.chatId === chatId) void refresh();
	});

	if (!available) return null;
	return (
		<Hint label="Warm up: recap what you studied and recall it" side="bottom">
			<button
				type="button"
				data-testid="warmup-chip"
				disabled={!canStart}
				onClick={onStart}
				className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
			>
				<FlameIcon className="size-3.5 text-primary" aria-hidden />
				Warm up
			</button>
		</Hint>
	);
}
