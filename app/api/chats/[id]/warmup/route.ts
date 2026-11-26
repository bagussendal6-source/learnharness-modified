import { warmupOfferFor } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Welcome-back gate's data: is a warm-up offered for this session (idle
 *  past the threshold, a plan with checks, no question waiting) and what it
 *  would cover. Starting it is the `warmup` input event on POST /api/chat. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const offer = warmupOfferFor(id);
	if (!offer) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(offer);
}
