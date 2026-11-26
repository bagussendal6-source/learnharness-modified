import { draftNotesPage } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Close session, step 1: the strong model drafts the next page. Nothing is
 *  saved — the learner reviews, then POSTs /notes/pages. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = await draftNotesPage(id, req.signal);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ draft: result.draft, toMessageId: result.toMessageId, pageNumber: result.pageNumber, nextConcept: result.nextConcept });
}
