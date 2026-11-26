import { detachRoadmapFolder, makeRoadmapFolder, roadmapStatus, type RoadmapResult } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function respond(result: RoadmapResult<object>) {
	if (result.ok) return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	return Response.json({ error: result.error, code: result.code }, { status: result.status });
}

const nameOf = async (params: Promise<{ name: string }>) => decodeURIComponent((await params).name);

/** Is this folder a roadmap folder, and where is its setup. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
	return respond(roadmapStatus(await nameOf(params)));
}

/** "Make this a roadmap folder" (restores a saved roadmap when there is one). */
export async function POST(_req: Request, { params }: { params: Promise<{ name: string }> }) {
	return respond(makeRoadmapFolder(await nameOf(params)));
}

/** Back to a regular folder. Keeps the roadmap's data and every session. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ name: string }> }) {
	return respond(detachRoadmapFolder(await nameOf(params)));
}
