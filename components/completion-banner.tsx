"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, GraduationCapIcon } from "lucide-react";
import { useServerEvent } from "@/components/server-events";

/**
 * The completion strip of a TEACHING session (core/exam.ts decides everything):
 *
 *   plan covered, no exam yet      → "All plan clear — take the final exam."
 *   exam taken, below the pass mark → "All plan clear · Exam not passed (best C, 72%) — need retest!"
 *   exam passed (B or better)       → "Completed · B (88%)"
 *
 * Renders nothing until the whole plan has been covered. The status is DERIVED
 * on the server from the transcript + the chat's exam sessions, so this strip
 * only fetches it — on mount and whenever the chat or the session list changes.
 */

type Status = "not-covered" | "ready" | "not-passed" | "completed";
interface CompletionPayload {
	status: Status;
	line: string | null;
}

export function CompletionBanner({ chatId }: { chatId: string }) {
	const router = useRouter();
	const [data, setData] = useState<CompletionPayload | null>(null);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}/completion`);
			if (!res.ok) return;
			setData((await res.json()) as CompletionPayload);
		} catch {
			// silent: the strip simply stays as it was
		}
	}, [chatId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);
	useServerEvent("turn-settled", (p) => {
		if (p.chatId === chatId) void refresh();
	});
	// An exam session finishing/being created changes this chat's status.
	useServerEvent("chats-changed", () => void refresh());

	const startExam = async () => {
		setStarting(true);
		setError(null);
		try {
			const res = await fetch(`/api/chats/${chatId}/exam`, { method: "POST" });
			const body = (await res.json().catch(() => ({}))) as { id?: string; prompt?: string; error?: string };
			if (!res.ok || !body.id) throw new Error(body.error ?? `Could not start the exam (${res.status})`);
			router.push(`/chat/${body.id}?prompt=${encodeURIComponent(body.prompt ?? "Begin the final exam.")}`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not start the exam.");
			setStarting(false);
		}
	};

	if (!data || data.status === "not-covered" || !data.line) return null;
	const done = data.status === "completed";
	const tone = done ? "border-primary/40 text-foreground" : data.status === "not-passed" ? "border-destructive/50 text-foreground" : "border-border text-foreground";
	return (
		<div data-testid="completion-banner" data-status={data.status} className={`flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs ${tone}`}>
			{done ? <CheckCircle2Icon className="size-4 text-primary" aria-hidden /> : <GraduationCapIcon className="size-4 text-muted-foreground" aria-hidden />}
			<span className="min-w-0 flex-1 truncate" data-testid="completion-line">{data.line}</span>
			{error && <span className="text-destructive">{error}</span>}
			<button
				type="button"
				disabled={starting}
				onClick={() => void startExam()}
				data-testid="completion-exam"
				className="shrink-0 rounded-sm border border-border px-2.5 py-1 transition-colors hover:bg-accent disabled:opacity-50"
			>
				{starting ? "Preparing the exam…" : data.status === "ready" ? "Take the final exam" : data.status === "not-passed" ? "Retake the exam" : "Take it again"}
			</button>
		</div>
	);
}
