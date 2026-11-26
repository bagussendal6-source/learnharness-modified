import { compactionInFlight, deleteChatSession, fileSession, getChat, isTurnRunning, sessionCoverage, sessionCost, stores, turnFailure, type ChatDeleteMode } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	// turnInFlight lets a returning client re-attach to a running turn
	// (chat-handler write-ahead + registry — see src/server/turn-liveness.ts).
	// coverage (extraction-UX redesign, 2026-09-24): the chat view's ring
	// meter + sidebar block — THE coverage surface (the all-sessions GET
	// route died with the redesign; the Extract POST stays). getChat
	// already 404'd, so the block exists.
	// Wave D (owner-approved 2026-09-26): the record's messages are native
	// agent history, served VERBATIM — the client derives its view
	// (core/view.ts projectView). turnInFlight lets a returning client
	// re-attach to a running turn; coverage is the chat view's ring meter.
	return Response.json({
		...chat,
		messages: chat.messages,
		pricing: sessionCost(chat),
		turnInFlight: isTurnRunning(id),
		// Also reaches idle views that missed the failing turn's stream.
		turnError: turnFailure(id),
		compacting: compactionInFlight(id),
		coverage: sessionCoverage(id),
	});
}

/**
 * Rename (2026-09-17): the header's click-to-edit title commits here; the
 * same route files a session (folder, null = unfile) and sets its tags.
 * Title validation is a single rule — a non-empty string after trim (the store's
 * "Untitled session" floor is never reached from this route). updatedAt is
 * deliberately NOT bumped: a rename must not reorder the sidebar (same
 * rule as the settings PUT).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { title?: unknown; folder?: unknown; tags?: unknown } | null;
	const hasTitle = body !== null && "title" in body;
	const hasFolder = body !== null && "folder" in body;
	const hasTags = body !== null && "tags" in body;
	if (!hasTitle && !hasFolder && !hasTags) {
		return Response.json({ error: "title, folder or tags is required" }, { status: 400 });
	}
	if (hasTitle && (typeof body?.title !== "string" || body.title.trim() === "")) {
		return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	}
	if (hasFolder && body?.folder !== null && typeof body?.folder !== "string") {
		return Response.json({ error: "folder must be a string or null" }, { status: 400 });
	}
	if (hasTags && !Array.isArray(body?.tags)) {
		return Response.json({ error: "tags must be an array of strings" }, { status: 400 });
	}
	if (hasTitle) stores.chatStore.renameChat(id, (body!.title as string).trim());
	if (hasTags) stores.chatStore.setOrganization(id, { tags: body!.tags as string[] });
	if (hasFolder) fileSession(id, body!.folder);
	const record = stores.chatStore.getChat(id)!;
	return Response.json({ title: record.title, folder: record.folder ?? null, tags: record.tags ?? [] });
}

/**
 * DELETE /api/chats/[id]?mode=preserve-graph|delete-nodes — session deletion
 * (wave 6, owner rulings 2026-09-22/23). The mode is REQUIRED and explicit:
 * no default, because the two differ in destructiveness —
 *
 *   preserve-graph  the session record, its jobs, and its extraction
 *                   bookkeeping (coverage/checkpoint rows) die; the graph
 *                   keeps every contribution the session merged.
 *   delete-nodes    "this session never happened": every ledger trace of
 *                   the session goes too — provenance, link lines,
 *                   events, mappings — and orphaned nodes die entirely
 *                   (shared nodes survive automatically, their other
 *                   sessions' content intact).
 *
 * Gates are the server orchestration's (server/chats.ts deleteChatSession):
 * 409 while a turn or background job is running, 503 while the session's
 * extraction is winding down after its abort — both retryable. The
 * response carries what was removed plus the new graphRevision (the
 * version stamp the UI polls to refetch clusters/layout).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mode = new URL(req.url).searchParams.get("mode");
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		return Response.json(
			{
				error: 'mode is required and must be "preserve-graph" or "delete-nodes"',
				code: "bad_mode",
			},
			{ status: 400 },
		);
	}
	const outcome = await deleteChatSession(id, mode as ChatDeleteMode);
	if (!outcome.ok) {
		return Response.json(
			{
				error: outcome.error,
				code: outcome.code,
				...("jobIds" in outcome ? { jobIds: outcome.jobIds } : {}),
		},
			{ status: outcome.status },
		);
	}
	return Response.json({
		ok: true,
		mode: outcome.mode,
		stats: outcome.stats,
		jobsRemoved: outcome.jobsRemoved,
		graphRevision: outcome.graphRevision,
	});
}

