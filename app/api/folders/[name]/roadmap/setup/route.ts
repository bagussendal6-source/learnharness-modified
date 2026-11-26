import { roadmapSetupView, type SetupResult } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function respond(result: SetupResult<object>) {
	if (result.ok) return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	return Response.json({ error: result.error, code: result.code, ...(result.problems ? { problems: result.problems } : {}) }, { status: result.status });
}

/** Everything the roadmap setup screen draws: units, books, page checks, blockers. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
	return respond(roadmapSetupView(decodeURIComponent((await params).name)));
}
