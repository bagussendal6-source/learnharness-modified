import { folderOverview } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The folder overview page's data: one derived card per session in the folder. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	return Response.json(folderOverview(decodeURIComponent(name)));
}
