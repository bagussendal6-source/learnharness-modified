"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SparklesIcon, XIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { normalizeFolderName, normalizeTag, normalizeTags, type ChatListItem } from "@/src/core";

/**
 * Folder + tags for one session. The folder is free text (an existing one
 * from the list, or a new name); tags are free chips. "Suggest with AI"
 * only PROPOSES tags (dashed chips) — nothing is saved until Save, and a
 * suggestion is accepted by clicking it.
 */
export function OrganizeDialog({
	chat,
	folders,
	knownTags,
	onClose,
	onSaved,
}: {
	chat: Pick<ChatListItem, "id" | "title" | "folder" | "tags"> | null;
	folders: string[];
	knownTags: string[];
	onClose: () => void;
	onSaved: (id: string, next: { folder: string | null; tags: string[] }) => void;
}) {
	const [folder, setFolder] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [draft, setDraft] = useState("");
	const [suggested, setSuggested] = useState<string[]>([]);
	const [suggesting, setSuggesting] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!saving) onClose();
	});

	useEffect(() => {
		if (!chat) return;
		setFolder(chat.folder ?? "");
		setTags(chat.tags ?? []);
		setDraft("");
		setSuggested([]);
		setError(null);
		setSaving(false);
		setSuggesting(false);
	}, [chat]);

	useEffect(() => {
		if (!chat) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [chat, onClose]);

	if (!chat) return null;

	const addTag = (raw: string) => {
		const tag = normalizeTag(raw);
		if (tag) setTags((prev) => normalizeTags([...prev, tag]));
		setSuggested((prev) => prev.filter((t) => t !== tag));
	};
	const commitDraft = () => {
		for (const part of draft.split(",")) addTag(part);
		setDraft("");
	};

	const suggest = async () => {
		setSuggesting(true);
		setError(null);
		try {
			const res = await fetch(`/api/chats/${chat.id}/tags/suggest`, { method: "POST" });
			const body = (await res.json()) as { tags?: string[]; error?: string };
			if (!res.ok) throw new Error(body.error ?? `Suggestion failed (${res.status})`);
			setSuggested((body.tags ?? []).filter((t) => !tags.includes(t)));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Suggestion failed.");
		} finally {
			setSuggesting(false);
		}
	};

	const save = async () => {
		setSaving(true);
		setError(null);
		const finalTags = normalizeTags([...tags, ...draft.split(",")]);
		const finalFolder = normalizeFolderName(folder);
		try {
			const res = await fetch(`/api/chats/${chat.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ folder: finalFolder, tags: finalTags }),
			});
			if (!res.ok) throw new Error(`Save failed (${res.status})`);
			window.dispatchEvent(new Event("lh:library-changed"));
			onSaved(chat.id, { folder: finalFolder, tags: finalTags });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Save failed.");
			setSaving(false);
		}
	};

	const chip = "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-ui text-xs";
	const unused = knownTags.filter((t) => !tags.includes(t) && !suggested.includes(t)).slice(0, 12);

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Folder and tags"
				data-testid="organize-dialog"
				onClick={(e) => e.stopPropagation()}
				className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="text-sm font-semibold text-foreground">Folder &amp; tags</h2>
				<div className="mt-1 truncate font-mono text-xs text-muted-foreground">{chat.title}</div>

				<label className="mt-4 block text-xs uppercase tracking-wider text-muted-foreground">Folder</label>
				<input
					list="organize-folders"
					value={folder}
					onChange={(e) => setFolder(e.target.value)}
					placeholder="e.g. Kalkulus II — empty = no folder"
					data-testid="organize-folder"
					className="mt-1 w-full rounded-sm border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-muted-foreground/60"
				/>
				<datalist id="organize-folders">
					{folders.map((f) => <option key={f} value={f} />)}
				</datalist>

				<div className="mt-4 flex items-center justify-between">
					<label className="text-xs uppercase tracking-wider text-muted-foreground">Tags</label>
					<button
						type="button"
						data-testid="organize-suggest"
						disabled={suggesting}
						onClick={() => void suggest()}
						className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
					>
						<SparklesIcon className={suggesting ? "size-3 animate-pulse" : "size-3"} />
						{suggesting ? "Thinking…" : "Suggest with AI"}
					</button>
				</div>
				<div className="mt-1 flex flex-wrap gap-1.5" data-testid="organize-tags">
					{tags.map((t) => (
						<span key={t} className={`${chip} border-border bg-background text-foreground`}>
							{t}
							<button type="button" aria-label={`Remove ${t}`} onClick={() => setTags((p) => p.filter((x) => x !== t))} className="text-muted-foreground hover:text-foreground">
								<XIcon className="size-3" />
							</button>
						</span>
					))}
					{suggested.map((t) => (
						<button key={t} type="button" data-testid="organize-suggested" title="Accept this suggestion" onClick={() => addTag(t)} className={`${chip} border-dashed border-border text-muted-foreground hover:text-foreground`}>
							+ {t}
						</button>
					))}
					<input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === ",") {
								e.preventDefault();
								commitDraft();
							} else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
								setTags((p) => p.slice(0, -1));
							}
						}}
						placeholder="add a tag…"
						data-testid="organize-tag-input"
						className="min-w-24 flex-1 bg-transparent px-1 py-0.5 text-xs outline-none placeholder:text-muted-foreground"
					/>
				</div>
				{unused.length > 0 && (
					<div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
						<span>Used elsewhere:</span>
						{unused.map((t) => (
							<button key={t} type="button" onClick={() => addTag(t)} className="rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground">
								{t}
							</button>
						))}
					</div>
				)}

				{error && <div role="alert" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs text-foreground">{error}</div>}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" onClick={onClose} disabled={saving} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">
						Cancel
					</button>
					<button type="button" data-testid="organize-save" onClick={() => void save()} disabled={saving} className="rounded-sm border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40">
						Save
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
