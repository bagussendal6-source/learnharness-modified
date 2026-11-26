import { approveRoadmap, type SetupResult } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The learner approves the page mapping; the folder becomes active. */
export async function POST(_req: Request, { params }: { params: Promise<{ name: string }> }) {
	const result: SetupResult<object> = approveRoadmap(decodeURIComponent((await params).name));
	if (result.ok) return Response.json(result);
	return Response.json({ error: result.error, code: result.code, ...(result.problems ? { problems: result.problems } : {}) }, { status: result.status });
}
