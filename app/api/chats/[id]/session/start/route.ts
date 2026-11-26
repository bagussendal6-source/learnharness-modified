import { startSessionWithoutWarmup } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start the next session WITHOUT a warm-up (ends the closed state; the check
 *  that was waiting returns). With a warm-up, the client sends the `warmup`
 *  input to /api/chat instead. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = startSessionWithoutWarmup(id);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ ok: true });
}
