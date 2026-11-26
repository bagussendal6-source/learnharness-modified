import { deleteFile, updateFile } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { name?: unknown; folder?: unknown } | null;
	const result = updateFile(id, { name: body?.name, folder: body?.folder });
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ file: result.file });
}

/** Deleting always warns: without ?confirm=1 the answer is 409 confirm_required
 *  (with the sessions that attached the file); the UI confirms, then retries. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = deleteFile(id, new URL(req.url).searchParams.get("confirm") === "1");
	if (result.ok) return Response.json({ ok: true });
	return Response.json({ error: result.error, code: result.code, sessions: result.sessions ?? [] }, { status: result.status });
}
