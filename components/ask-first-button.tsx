"use client";

import { MessageCircleQuestionMarkIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Ask first": pause the pending check to ask the teacher something. The check
 * is not skipped for good — the teacher is told to answer, then pose it again.
 */
export function AskFirstButton({ onClick, className }: { onClick: () => void; className?: string }) {
	return (
		<button
			type="button"
			data-testid="ask-first"
			title="Pause this question and ask the teacher something first. The question comes back afterwards."
			onClick={onClick}
			className={cn("inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", className)}
		>
			<MessageCircleQuestionMarkIcon className="size-3.5" />
			Ask first
		</button>
	);
}
