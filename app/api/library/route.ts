import { libraryView } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The folder list + every stored file (the Files panel and the attach picker). */
export async function GET() {
	return Response.json(libraryView(), { headers: { "Cache-Control": "no-store" } });
}
