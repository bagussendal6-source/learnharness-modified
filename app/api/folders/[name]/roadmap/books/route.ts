import { addBook, listBooks, type BookResult } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function respond(result: BookResult<object>) {
	if (result.ok) return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	return Response.json({ error: result.error, code: result.code }, { status: result.status });
}

const nameOf = async (params: Promise<{ name: string }>) => decodeURIComponent((await params).name);

/** The roadmap folder's ingested books (manifests only — never page text). */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
	return respond(listBooks(await nameOf(params)));
}

/** Add one PDF by its full path. Read once and saved as an index; the same
 *  file added again is a no-op. */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
	const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
	return respond(await addBook(await nameOf(params), body?.path));
}
