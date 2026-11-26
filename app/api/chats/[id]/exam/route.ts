import { examStateOf, startExam } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a FINAL EXAM for this (teaching) session. 409 until the whole plan is
 *  covered. Returns the new exam session's id + the opening prompt the client
 *  delivers as turn 1 (/chat/<id>?prompt=…). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = startExam(id);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json({ id: result.id, prompt: result.prompt });
}

/** An EXAM session's current result (score, grade, per-proposition rows). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = examStateOf(id);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	return Response.json(result.state);
}
