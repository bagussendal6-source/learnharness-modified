import { emptyNotes, openSessionSlice, sessionStats, sliceHasLearnerActivity } from "@/src/core";
import { getChat, stores } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The chat's notes document plus whether the open session has anything to
 *  close (the Close session button's gate). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	const notes = stores.notesStore.readNotes(id) ?? emptyNotes(id);
	const slice = openSessionSlice(chat.messages, notes.pages);
	return Response.json({
		pages: notes.pages,
		canClose: slice !== null && sliceHasLearnerActivity(slice.messages),
		// What happened in each session (core/sessions.ts) — the Sessions panel.
		sessions: sessionStats(chat.messages, notes.pages, chat.tree),
	});
}
