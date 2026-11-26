"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WelcomeBackDetails } from "@/src/core";

/**
 * The transcript's face of the welcome-back brief (the graph-context card's
 * sibling): a minimal collapsed line — "Warm-up · 9 days away · 4 items" —
 * that expands to what was recapped and why each item was chosen. The teacher
 * reads the brief through the marker's own text; this is the learner's view.
 */
export function WelcomeBackCard({ data }: { data: WelcomeBackDetails }) {
	const [open, setOpen] = useState(false);
	const { idleDays = 0, covered = [], stoppedAt = null, items = [] } = data ?? {};
	return (
		<div data-testid="welcome-back-card" className="my-1">
			<button
				type="button"
				data-testid="welcome-back-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Warm-up</span>
				<span className="min-w-0 flex-1 truncate">
					{idleDays} day{idleDays === 1 ? "" : "s"} away · {items.length} item{items.length === 1 ? "" : "s"}
				</span>
			</button>
			{open && (
				<div data-testid="welcome-back-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{covered.length > 0 && (
						<div>
							<div className="uppercase tracking-wider text-muted-foreground">Covered so far</div>
							<div className="mt-0.5 text-foreground/80">{covered.join(" → ")}</div>
						</div>
					)}
					{stoppedAt && (
						<div>
							<span className="uppercase tracking-wider text-muted-foreground">Stopped at </span>
							<span className="text-foreground/80">{stoppedAt}</span>
						</div>
					)}
					<div>
						<div className="uppercase tracking-wider text-muted-foreground">Warming up</div>
						<ul className="mt-0.5 space-y-0.5">
							{items.map((i) => (
								<li key={i.nodeId} className="leading-relaxed">
									<span className="font-medium text-foreground/80">{i.title}</span>
									<span className="text-muted-foreground"> — {i.reason}</span>
								</li>
							))}
						</ul>
					</div>
				</div>
			)}
		</div>
	);
}
