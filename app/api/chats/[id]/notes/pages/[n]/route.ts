import { getChat, stores } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ONE editable thing on a saved page: the learner's own-words text. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
	const { id, n } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { own?: unknown } | null;
	if (typeof body?.own !== "string") return Response.json({ error: "own must be a string" }, { status: 400 });
	const pageNumber = Number(n);
	if (!Number.isInteger(pageNumber)) return Response.json({ error: "bad page number" }, { status: 400 });
	try {
		const record = stores.notesStore.setOwn(id, pageNumber, body.own);
		return Response.json({ pages: record.pages });
	} catch {
		return Response.json({ error: "Page not found" }, { status: 404 });
	}
}
