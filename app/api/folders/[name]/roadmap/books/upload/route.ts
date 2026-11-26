import { addUploadedBook, type BookResult } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Add a book from the file picker: the raw PDF bytes, the file's name in the
 *  `x-file-name` header. Streamed to disk (no 50 MB upload limit), read once,
 *  saved as an index; the same file again is a no-op. */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
	const result: BookResult<object> = await addUploadedBook(decodeURIComponent((await params).name), decodeURIComponent(req.headers.get("x-file-name") ?? ""), req.body);
	if (result.ok) return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	return Response.json({ error: result.error, code: result.code }, { status: result.status });
}
