import { FolderPage } from "@/components/folder-page";

export const dynamic = "force-dynamic";

function safeDecode(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** A folder's overview: every session in it with its tags, material, progress,
 *  completion, and notes (core/folder-overview.ts). */
export default async function FolderRoute({ params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	return <FolderPage name={safeDecode(name)} />;
}
