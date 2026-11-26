import { closeWithoutNotes } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Close the session WITHOUT writing notes: appends an empty boundary page (no
 *  model call). The next session starts after it. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = closeWithoutNotes(id);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ page: result.page, pages: result.record.pages });
}
