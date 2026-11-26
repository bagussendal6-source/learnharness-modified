import { importRoadmapFile, importRoadmapText, type SetupResult } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function respond(result: SetupResult<object>) {
	if (result.ok) return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	return Response.json({ error: result.error, code: result.code, ...(result.problems ? { problems: result.problems } : {}) }, { status: result.status });
}

/** Import the roadmap: JSON `{ text }` (pasted), or the raw file bytes with
 *  the file's name in the `x-file-name` header (PDF, .txt or .md). Anything the
 *  reader can't understand comes back as `problems`, and nothing is saved. */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
	const name = decodeURIComponent((await params).name);
	if ((req.headers.get("content-type") ?? "").includes("application/json")) {
		const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
		return respond(importRoadmapText(name, body?.text));
	}
	const fileName = decodeURIComponent(req.headers.get("x-file-name") ?? "");
	return respond(await importRoadmapFile(name, fileName, new Uint8Array(await req.arrayBuffer())));
}
