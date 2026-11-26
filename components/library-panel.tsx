"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon, FileTextIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { formatBytes, notifyLibraryChanged } from "@/components/library";
import type { LibraryFile } from "@/src/core";

export const FILE_ACCEPT = ".pdf,.ppt,.pptx,.doc,.docx,.md,.markdown,.txt";

/** Upload into a folder (null = unfiled) through the same /api/sources the
 *  paperclip uses. Resolves to an error line, or null on success. */
export async function uploadToLibrary(files: FileList | File[], folder: string | null): Promise<string | null> {
	const list = Array.from(files);
	if (list.length === 0) return null;
	const body = new FormData();
	for (const file of list) body.append("files", file);
	if (folder) body.append("folder", folder);
	try {
		const res = await fetch("/api/sources", { method: "POST", body });
		const result = (await res.json()) as { error?: string };
		if (!res.ok) return result.error ?? "Upload failed.";
		notifyLibraryChanged();
		return null;
	} catch {
		return "Upload failed — network error.";
	}
}

/** The delete warning: always shown before bytes go; lists the sessions that
 *  attached the file (they can't re-read it afterwards). */
function DeleteFileDialog({
	file,
	message,
	sessions,
	busy,
	onCancel,
	onConfirm,
}: {
	file: LibraryFile;
	message: string;
	sessions: { id: string; title: string }[];
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onCancel();
	});
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Delete file"
				data-testid="delete-file-dialog"
				onClick={(e) => e.stopPropagation()}
				className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="text-sm font-semibold text-destructive">Delete file?</h2>
				<code className="mt-1.5 block truncate font-mono text-sm text-foreground">{file.name}</code>
				<p className="mt-2 text-sm text-muted-foreground">{message}</p>
				{sessions.length > 0 && (
					<ul data-testid="delete-file-sessions" className="mt-2 max-h-28 list-disc overflow-y-auto pl-5 text-xs text-muted-foreground">
						{sessions.map((s) => <li key={s.id} className="truncate">{s.title}</li>)}
					</ul>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" onClick={onCancel} disabled={busy} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">
						Cancel
					</button>
					<button type="button" data-testid="delete-file-confirm" onClick={onConfirm} disabled={busy} className="rounded-sm border border-destructive/60 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive hover:text-white disabled:opacity-40">
						Delete
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** A folder's stored files: ONE compact row ("Files · N", closed by default)
 *  that opens a height-capped, scrollable list — so a folder with many files
 *  never pushes the sessions around. Upload (button, or drop on the row) and
 *  delete-with-warning live here. Pure storage — nothing is read by the AI
 *  until a file is attached. */
export function FolderFiles({ folder, files }: { folder: string | null; files: LibraryFile[] }) {
	const input = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const [over, setOver] = useState(false);
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState<{ file: LibraryFile; message: string; sessions: { id: string; title: string }[] } | null>(null);
	const [deleting, setDeleting] = useState(false);

	const upload = async (list: FileList | File[]) => {
		setUploading(true);
		setError(await uploadToLibrary(list, folder));
		setUploading(false);
		if (input.current) input.current.value = "";
	};

	const askDelete = async (file: LibraryFile) => {
		setError(null);
		try {
			const res = await fetch(`/api/library/files/${file.id}`, { method: "DELETE" });
			const body = (await res.json()) as { message?: string; error?: string; code?: string; sessions?: { id: string; title: string }[] };
			if (res.status === 409 && body.code === "confirm_required") {
				setPending({ file, message: body.error ?? "This can't be undone.", sessions: body.sessions ?? [] });
			} else if (!res.ok) setError(body.error ?? "Delete failed.");
		} catch {
			setError("Delete failed — network error.");
		}
	};

	const confirmDelete = async () => {
		if (!pending) return;
		setDeleting(true);
		try {
			const res = await fetch(`/api/library/files/${pending.file.id}?confirm=1`, { method: "DELETE" });
			if (!res.ok) setError("Delete failed.");
			else notifyLibraryChanged();
		} catch {
			setError("Delete failed — network error.");
		}
		setDeleting(false);
		setPending(null);
	};

	return (
		<div
			data-testid="folder-files"
			onDragOver={(e) => { e.preventDefault(); setOver(true); }}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				setOver(false);
				void upload(e.dataTransfer.files);
			}}
			className={`mb-1 rounded-md px-1.5 py-0.5 ${over ? "bg-accent/60 ring-1 ring-foreground/30" : ""}`}
		>
			<div className="flex items-center gap-1">
				<button type="button" data-testid="folder-files-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
					<ChevronRightIcon className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
					<span className="min-w-0 flex-1 truncate">{files.length === 0 ? "Files · drop here" : `Files · ${files.length}`}</span>
				</button>
				<button type="button" aria-label="Add files" title="Add files" data-testid="folder-upload" disabled={uploading} onClick={() => input.current?.click()} className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">
					<PlusIcon className={uploading ? "size-3 animate-pulse" : "size-3"} />
				</button>
			</div>
			<input ref={input} type="file" multiple accept={FILE_ACCEPT} className="hidden" data-testid="folder-file-input" onChange={(e) => e.target.files && void upload(e.target.files)} />
			{open && files.length > 0 && (
				<div data-testid="folder-files-list" className="max-h-36 overflow-y-auto pb-0.5">
					{files.map((file) => (
						<div key={file.id} title={`${file.name} · ${formatBytes(file.size)}`} className="group flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground">
							<FileTextIcon className="size-3 shrink-0" />
							<span className="min-w-0 flex-1 truncate">{file.name}</span>
							<button type="button" aria-label={`Delete ${file.name}`} data-testid="file-delete" onClick={() => void askDelete(file)} className="shrink-0 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100">
								<Trash2Icon className="size-3" />
							</button>
						</div>
					))}
				</div>
			)}
			{error && <div role="alert" className="px-1 pt-0.5 text-[11px] text-red-400">{error}</div>}
			{pending && (
				<DeleteFileDialog
					file={pending.file}
					message={pending.message}
					sessions={pending.sessions}
					busy={deleting}
					onCancel={() => setPending(null)}
					onConfirm={() => void confirmDelete()}
				/>
			)}
		</div>
	);
}
