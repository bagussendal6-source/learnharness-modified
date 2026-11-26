import { completionLine } from "@/src/core";
import { completionForChat } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The chat's completion: plan coverage + exam attempts folded into one status
 *  (not-covered | ready | not-passed | completed) and its one-line text. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = completionForChat(id);
	if (!result.ok) return Response.json({ error: result.error, code: result.code }, { status: result.status });
	const c = result.completion;
	return Response.json({
		status: c.status,
		line: completionLine(c),
		coverage: c.coverage,
		best: c.best ? { examChatId: c.best.examChatId, ...pick(c.best.result) } : null,
		attempts: c.attempts.map((a) => ({ examChatId: a.examChatId, at: a.at, ...pick(a.result) })),
	});
}

function pick(r: { percent: number; grade: string; passed: boolean; finished: boolean; concluded: number; total: number }) {
	return { percent: r.percent, grade: r.grade, passed: r.passed, finished: r.finished, concluded: r.concluded, total: r.total };
}
