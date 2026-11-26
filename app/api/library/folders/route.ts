import { createFolder, deleteFolder, renameFolder, type LibraryResult } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function respond(result: LibraryResult<object>) {
	if (result.ok) return Response.json(result);
	return Response.json({ error: result.error, code: result.code }, { status: result.status });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
	return respond(createFolder(body?.name));
}

export async function PATCH(req: Request) {
	const body = (await req.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
	return respond(renameFolder(body?.from, body?.to));
}

/** Dissolves the folder: its sessions and files become unfiled (never deleted). */
export async function DELETE(req: Request) {
	return respond(deleteFolder(new URL(req.url).searchParams.get("name")));
}
