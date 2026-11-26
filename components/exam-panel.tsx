"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useServerEvent } from "@/components/server-events";
import { PASS_PERCENT, type ExamResult } from "@/src/core";

/**
 * The FINAL-EXAM panel of an exam session: progress while it runs, then the
 * grade. The score is computed by code from the exam's own transcript
 * (core/exam.ts scoreExam) — never by the model — and fetched from the server,
 * refreshed whenever a turn settles or the record changes (a dismissed problem
 * concludes without a turn).
 */

interface ExamState {
	parentChatId: string;
	parentTitle: string;
	result: ExamResult;
	propositions: Record<string, string>;
}

export function ExamPanel({ chatId }: { chatId: string }) {
	const [state, setState] = useState<ExamState | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}/exam`);
			if (res.ok) setState((await res.json()) as ExamState);
		} catch {
			// silent
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

	if (!state) return null;
	const r = state.result;
	if (!r.finished) {
		return (
			<div data-testid="exam-panel" data-finished="false" className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
				<span>
					Final exam · {r.concluded}/{r.total} answered · no hints · pass mark {PASS_PERCENT}% (B)
				</span>
			</div>
		);
	}
	const weak = r.perProposition.filter((p) => p.points / p.of < 0.6);
	const strong = r.perProposition.filter((p) => p.points / p.of >= 0.6);
	const name = (id: string) => state.propositions[id] ?? id;
	return (
		<div data-testid="exam-panel" data-finished="true" data-passed={r.passed ? "true" : "false"} className={`shrink-0 border-b px-4 py-3 text-xs ${r.passed ? "border-primary/40" : "border-destructive/50"}`}>
			<div className="flex items-baseline gap-3">
				<span className="font-title text-2xl tracking-tight text-foreground" data-testid="exam-grade">
					{r.grade}
				</span>
				<span className="text-sm text-foreground" data-testid="exam-percent">
					{r.percent}%
				</span>
				<span className="text-muted-foreground">
					{r.passed ? "Passed — the plan is complete." : `Not passed (need ${PASS_PERCENT}% / B) — retake from the session.`}
				</span>
				<span className="flex-1" />
				<Link href={`/chat/${state.parentChatId}`} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" data-testid="exam-back">
					Back to “{state.parentTitle}”
				</Link>
			</div>
			{r.perProposition.length > 0 && (
				<div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
					{weak.length > 0 && (
						<div data-testid="exam-weak">
							<div className="uppercase tracking-wider text-muted-foreground">To review</div>
							<ul className="mt-0.5 list-disc pl-4 text-foreground">
								{weak.map((p) => (
									<li key={p.id}>{name(p.id)}</li>
								))}
							</ul>
						</div>
					)}
					{strong.length > 0 && (
						<div>
							<div className="uppercase tracking-wider text-muted-foreground">Solid</div>
							<ul className="mt-0.5 list-disc pl-4 text-foreground">
								{strong.map((p) => (
									<li key={p.id}>{name(p.id)}</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
