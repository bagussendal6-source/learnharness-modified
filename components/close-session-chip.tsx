"use client";

import { useCallback, useEffect, useState } from "react";
import { PowerIcon } from "lucide-react";
import { useServerEvent } from "@/components/server-events";
import { Hint } from "@/components/ui/hint";

/**
 * The header's "Close session" button: it opens the notes dialog, where the two
 * ways to close live (write notes / close without notes). Shown only while the
 * OPEN session has something to close — the server decides (GET /notes canClose).
 */
export function CloseSessionChip({ chatId, onOpen }: { chatId: string; onOpen: () => void }) {
	const [canClose, setCanClose] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}/notes`);
			if (res.ok) setCanClose(((await res.json()) as { canClose?: boolean }).canClose === true);
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
	useServerEvent("record-changed", (p) => {
		if (p.chatId === chatId) void refresh();
	});
	useServerEvent("notes-changed", (p) => {
		if (p.chatId === chatId) void refresh();
	});

	if (!canClose) return null;
	return (
		<Hint label="Close this session — with or without notes" side="bottom">
			<button
				type="button"
				data-testid="close-session-chip"
				onClick={onOpen}
				className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<PowerIcon className="size-3.5 text-primary" aria-hidden />
				Close session
			</button>
		</Hint>
	);
}
