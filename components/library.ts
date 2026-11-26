"use client";

import { useCallback, useEffect, useState } from "react";
import type { LibraryView } from "@/src/core";

/** Same-tab announcement that folders/files changed (the library has no
 *  server-push channel of its own; every mutator calls this). */
export const LIBRARY_CHANGED = "lh:library-changed";
export const notifyLibraryChanged = () => window.dispatchEvent(new Event(LIBRARY_CHANGED));

/** The library snapshot (folders + stored files), refetched on change. */
export function useLibrary(enabled = true): { library: LibraryView | null; refresh: () => Promise<void> } {
	const [library, setLibrary] = useState<LibraryView | null>(null);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/library", { cache: "no-store" });
			if (res.ok) setLibrary((await res.json()) as LibraryView);
		} catch {
			// transient: keep the last snapshot
		}
	}, []);
	useEffect(() => {
		if (!enabled) return;
		void refresh();
		window.addEventListener(LIBRARY_CHANGED, refresh);
		return () => window.removeEventListener(LIBRARY_CHANGED, refresh);
	}, [enabled, refresh]);
	return { library, refresh };
}

/** "1.2 MB" — the picker/panel size column. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
