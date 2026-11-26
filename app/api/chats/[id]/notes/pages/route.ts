import { savePage } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Close session, step 2: validate and append the reviewed draft as the next
 *  page. Pages are append-only — there is no PUT/DELETE for a page's body. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { draft?: unknown; toMessageId?: unknown; own?: unknown; edited?: unknown } | null;
	if (!body || typeof body !== "object") return Response.json({ error: "JSON body required" }, { status: 400 });
	const result = savePage(id, body as { draft: unknown; toMessageId: unknown; own?: unknown; edited?: unknown });
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ page: result.page, pages: result.record.pages });
}
