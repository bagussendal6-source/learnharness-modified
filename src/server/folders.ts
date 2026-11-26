import { buildSessionCard, sortCards, type SessionCard } from "../core/folder-overview.ts";
import { sameFolder } from "../core/organize.ts";
import { examAttemptsOf } from "./exam.ts";
import { stores } from "./stores.ts";

/**
 * THE FOLDER OVERVIEW, server side: gathers each session of a folder (record,
 * its exam attempts, its notes) and folds them into cards with
 * core/folder-overview.ts. Read-only; nothing is stored.
 */
export function folderOverview(name: string): { folder: string; cards: SessionCard[] } {
	const members = stores.chatStore.listChats().filter((c) => c.folder !== undefined && sameFolder(c.folder, name) && c.exam === undefined);
	const cards: SessionCard[] = [];
	for (const summary of members) {
		const record = stores.chatStore.getChat(summary.id);
		if (!record) continue;
		cards.push(
			buildSessionCard({
				id: record.id,
				title: record.title,
				kind: record.kind,
				updatedAt: record.updatedAt,
				tags: record.tags,
				tree: record.tree,
				messages: record.messages,
				attempts: record.kind === "practice" ? [] : examAttemptsOf(record.id),
				pages: stores.notesStore.readNotes(record.id)?.pages ?? [],
			}),
		);
	}
	return { folder: members[0]?.folder ?? name, cards: sortCards(cards) };
}
