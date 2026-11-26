import { suggestTags } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** AI tag SUGGESTIONS for a session — nothing is saved here; the learner
 *  accepts via PUT /api/chats/:id {tags}. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = await suggestTags(id, req.signal);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ tags: result.tags });
}
