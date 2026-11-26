/**
 * POST /api/sources — the composer's paperclip: the learner picks files in a
 * native file dialog, the bytes land in <data>/sources/, and the absolute
 * paths come back so the message can reference them (the agent's fs and pdf
 * tools resolve absolute paths as-is). Multipart field "files".
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { stores } from "./stores.ts";

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED = new Set([".pdf", ".md", ".markdown", ".txt", ".ppt", ".pptx", ".doc", ".docx"]);
const CONVERT_TIMEOUT_MS = 180_000;

/** LibreOffice's `soffice` — PATH first, then the usual install spots (a packaged
 *  desktop app does not inherit the shell's PATH). */
function findSoffice(): string | undefined {
	const names = process.platform === "win32" ? ["soffice.exe"] : ["soffice"];
	const dirs = [
		...(process.env.PATH ?? "").split(path.delimiter),
		"/opt/homebrew/bin", "/usr/local/bin", "/Applications/LibreOffice.app/Contents/MacOS",
		"C:\\Program Files\\LibreOffice\\program",
	].filter(Boolean);
	return [process.env.LH_SOFFICE, ...dirs.flatMap((dir) => names.map((name) => path.join(dir, name)))].find((file): file is string => !!file && existsSync(file));
}

/** PowerPoint/Word → PDF through LibreOffice, so the PDF reader sees the slides (text AND rendered
 *  pages for diagrams/formulas). The result is named "<original>.pdf" so the chip can show
 *  the original deck name. Own throwaway profile: never collides with a running LibreOffice. */
async function slidesToPdf(source: string, outDir: string): Promise<string> {
	const soffice = findSoffice();
	if (!soffice) throw new Error("PowerPoint and Word files need LibreOffice (brew install --cask libreoffice), or save them as PDF first.");
	const profile = path.join(tmpdir(), `lh-soffice-${randomUUID().slice(0, 8)}`);
	try {
		await new Promise<void>((resolve, reject) => {
			execFile(soffice, [`-env:UserInstallation=file://${profile}`, "--headless", "--convert-to", "pdf", "--outdir", outDir, source], { timeout: CONVERT_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve()));
		});
	} finally {
		void rm(profile, { recursive: true, force: true }).catch(() => {});
	}
	const produced = path.join(outDir, `${path.basename(source, path.extname(source))}.pdf`);
	if (!existsSync(produced)) throw new Error("Could not convert the file. Save it as PDF and attach that instead.");
	const target = `${source}.pdf`;
	await rename(produced, target);
	return target;
}

function safeName(name: string): string {
	const base = path.basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim();
	return base || "source";
}

export async function sourceUploadResponse(request: Request): Promise<Response> {
	let form: FormData;
	try { form = await request.formData(); } catch { return Response.json({ error: "Expected multipart form data." }, { status: 400 }); }
	const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
	if (files.length === 0) return Response.json({ error: "No files." }, { status: 400 });
	const dir = path.join(PATHS.data, "sources");
	await mkdir(dir, { recursive: true });
	const folder = form.get("folder");
	const saved: { name: string; path: string; size: number }[] = [];
	for (const file of files) {
		const name = safeName(file.name);
		if (!ALLOWED.has(path.extname(name).toLowerCase())) return Response.json({ error: `${name}: only PDF, PowerPoint, Word, Markdown and text files.` }, { status: 415 });
		if (file.size > MAX_BYTES) return Response.json({ error: `${name}: over 50 MB.` }, { status: 413 });
		const target = path.join(dir, `${randomUUID().slice(0, 8)}-${name}`);
		await writeFile(target, Buffer.from(await file.arrayBuffer()));
		if (/\.(pptx?|docx?)$/i.test(name)) {
			try { saved.push({ name, path: await slidesToPdf(target, dir), size: file.size }); }
			catch (error) { return Response.json({ error: `${name}: ${error instanceof Error ? error.message : "conversion failed."}` }, { status: 422 }); }
		} else saved.push({ name, path: target, size: file.size });
	}
	// Every upload lands in the library (optionally filed); the response keeps
	// the {name, path} contract the composer's chips already read.
	const added = stores.libraryStore.addFiles(saved, typeof folder === "string" ? folder : null);
	return Response.json({ files: added.map((f) => ({ id: f.id, name: f.name, path: f.path })) }, { headers: { "Cache-Control": "no-store" } });
}
