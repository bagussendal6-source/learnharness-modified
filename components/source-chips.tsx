"use client";

import { PaperclipIcon, XIcon } from "lucide-react";
import { shortName, type SourceFile } from "@/components/source-lines";

/** Name chips for attached sources; `onRemove` omitted = read-only (transcript). */
export function SourceChips({ files, onRemove, className }: { files: SourceFile[]; onRemove?: (file: SourceFile) => void; className?: string }) {
	if (files.length === 0) return null;
	return <div className={`flex flex-wrap gap-1.5 ${className ?? ""}`} data-testid="source-chips">
		{files.map((file) => <span key={file.path} title={file.name} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 font-ui text-xs text-foreground">
			<PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
			<span className="truncate">{shortName(file.name)}</span>
			{onRemove && <button type="button" aria-label={`Remove ${file.name}`} className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => onRemove(file)}><XIcon className="size-3" /></button>}
		</span>)}
	</div>;
}
