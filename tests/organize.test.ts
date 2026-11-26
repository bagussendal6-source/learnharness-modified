/**
 * Folders, tags and the file library: pure normalizers, the chat store's
 * organization writes, and the library store (adoption, folder rename /
 * dissolve, file removal). Runs under an isolated LH_DATA_DIR (the seam is
 * set before any config-loading import, so app imports are dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-organize-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { normalizeTag, normalizeTags, normalizeFolderName, groupByFolder, storedFileName, MAX_TAGS } = await import("../src/core/organize.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { libraryStore } = await import("../src/store/library.ts");
const { deleteFile, deleteFolder, renameFolder, createFolder, fileSession, sessionsUsingFile } = await import("../src/server/library.ts");

test.after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

test("normalizers: tags are lowercase, dash-joined, deduped, capped", () => {
	assert.equal(normalizeTag("  #Teorema Green "), "teorema-green");
	assert.equal(normalizeTag(42), "");
	assert.deepEqual(normalizeTags(["Integral", "integral", " ", "Deret"]), ["integral", "deret"]);
	assert.equal(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, MAX_TAGS);
	assert.deepEqual(normalizeTags("nope"), []);
	assert.equal(normalizeFolderName("  Kalkulus   II "), "Kalkulus II");
	assert.equal(normalizeFolderName("   "), null);
});

test("groupByFolder: library order, case-insensitive, unfiled last", () => {
	const groups = groupByFolder([{ folder: "fisika" }, { folder: "Kalkulus" }, {}, { folder: "ghost" }], ["Kalkulus", "Fisika", "Kosong"]);
	assert.deepEqual(groups.map((g) => [g.folder, g.items.length]), [["Kalkulus", 1], ["Fisika", 1], ["Kosong", 0], [null, 2]]);
});

test("storedFileName: strips the id prefix and the converted .pdf twin", () => {
	assert.equal(storedFileName("/x/ab12cd34-deck.pptx.pdf"), "deck.pptx");
	assert.equal(storedFileName("/x/ab12cd34-notes.pdf"), "notes.pdf");
	assert.equal(storedFileName("/x/ab12cd34-memo.docx.pdf"), "memo.docx");
});

test("chat store: folder + tags persist, normalize, clear, and keep updatedAt", () => {
	const chat = chatStore.createChat("Limits", undefined, "  Kalkulus ");
	assert.equal(chat.folder, "Kalkulus");
	const before = chatStore.getChat(chat.id)!.updatedAt;
	const next = chatStore.setOrganization(chat.id, { tags: ["Integral", "integral", "Deret"] });
	assert.deepEqual(next.tags, ["integral", "deret"]);
	assert.equal(next.updatedAt, before, "organizing is not conversation activity");
	const summary = chatStore.listChats().find((c) => c.id === chat.id)!;
	assert.equal(summary.folder, "Kalkulus");
	assert.deepEqual(summary.tags, ["integral", "deret"]);
	const cleared = chatStore.setOrganization(chat.id, { folder: null, tags: [] });
	assert.equal(cleared.folder, undefined);
	assert.equal(cleared.tags, undefined);
});

test("folder rename and dissolve rewrite sessions AND files", () => {
	assert.equal(createFolder("Fisika").ok, true);
	assert.equal(createFolder("fisika").ok, false, "case-insensitive duplicate");
	const chat = chatStore.createChat("Gaya");
	fileSession(chat.id, "Fisika");
	const [file] = libraryStore.addFiles([{ name: "bab1.pdf", path: path.join(TMP_DATA, "sources", "aaaaaaaa-bab1.pdf"), size: 3 }], "Fisika");
	fs.mkdirSync(path.join(TMP_DATA, "sources"), { recursive: true });
	fs.writeFileSync(file!.path, "pdf");

	assert.equal(renameFolder("Fisika", "Fisika Dasar").ok, true);
	assert.equal(chatStore.getChat(chat.id)!.folder, "Fisika Dasar");
	assert.equal(libraryStore.getFile(file!.id)!.folder, "Fisika Dasar");

	assert.equal(deleteFolder("Fisika Dasar").ok, true);
	assert.equal(chatStore.getChat(chat.id)!.folder, undefined);
	assert.equal(libraryStore.getFile(file!.id)!.folder, undefined, "files are unfiled, never deleted");
	assert.equal(fs.existsSync(file!.path), true);
});

test("library adopts stray uploads, skips a converted original, prunes vanished files", () => {
	const dir = path.join(TMP_DATA, "sources");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "11111111-old.pdf"), "x");
	fs.writeFileSync(path.join(dir, "22222222-deck.pptx"), "x");
	fs.writeFileSync(path.join(dir, "22222222-deck.pptx.pdf"), "x");
	const names = libraryStore.view().files.map((f) => f.name);
	assert.ok(names.includes("old.pdf"));
	assert.ok(names.includes("deck.pptx"), "the PDF twin is listed under the deck's name");
	assert.equal(names.filter((n) => n === "deck.pptx").length, 1, "the original .pptx is not listed twice");
	fs.rmSync(path.join(dir, "11111111-old.pdf"));
	assert.ok(!libraryStore.view().files.some((f) => f.name === "old.pdf"), "vanished file is pruned");
});

test("deleting a file always warns first, lists the sessions that used it, then removes bytes", () => {
	const dir = path.join(TMP_DATA, "sources");
	const filePath = path.join(dir, "33333333-lecture.pdf");
	fs.writeFileSync(filePath, "x");
	const [file] = libraryStore.addFiles([{ name: "lecture.pdf", path: filePath, size: 1 }]);
	const chat = chatStore.createChat("Uses lecture");
	const record = chatStore.getChat(chat.id)!;
	fs.writeFileSync(path.join(TMP_DATA, "chats", `${chat.id}.json`), JSON.stringify({ ...record, messages: [{ role: "user", content: `hi\nSource file: ${filePath}\n`, id: "m1" }] }));

	assert.deepEqual(sessionsUsingFile(filePath).map((s) => s.id), [chat.id]);
	const warned = deleteFile(file!.id, false);
	assert.equal(warned.ok, false);
	if (!warned.ok) {
		assert.equal(warned.status, 409);
		assert.equal(warned.code, "confirm_required");
		assert.equal(warned.sessions?.length, 1);
	}
	assert.equal(fs.existsSync(filePath), true, "nothing deleted without confirmation");
	assert.equal(deleteFile(file!.id, true).ok, true);
	assert.equal(fs.existsSync(filePath), false);
	assert.equal(deleteFile(file!.id, true).ok, false, "gone is 404");
});

test("addFiles registers an upload once even though the bytes already sit in sources/", () => {
	const dir = path.join(TMP_DATA, "sources");
	const filePath = path.join(dir, "44444444-fresh.pdf");
	fs.writeFileSync(filePath, "x");
	libraryStore.addFiles([{ name: "fresh.pdf", path: filePath, size: 1 }], "Kimia");
	const hits = libraryStore.view().files.filter((f) => f.path === filePath);
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.folder, "Kimia");
});
