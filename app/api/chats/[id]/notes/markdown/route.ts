import { emptyNotes, renderNotesMarkdown } from "@/src/core";
import { getChat, stores } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "notes";
}

/** The whole notes document as one markdown file (attachment). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	const notes = stores.notesStore.readNotes(id) ?? emptyNotes(id);
	return new Response(renderNotesMarkdown(notes, chat.title), {
		headers: {
			"content-type": "text/markdown; charset=utf-8",
			"content-disposition": `attachment; filename="${slugify(chat.title)}-notes.md"`,
		},
	});
}
