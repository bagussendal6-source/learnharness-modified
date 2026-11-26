/**
 * Close WITHOUT notes, server side (src/server/notes.ts): it ends the open
 * session with an empty boundary page — no model call — and the next written
 * page carries on from it. Isolated LH_DATA_DIR; no LLM, no network.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import type { LhMessage } from "../src/core/native-messages.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-server-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { stores } = await import("../src/server/stores.ts");
const { closeWithoutNotes, savePage, startSessionWithoutWarmup } = await import("../src/server/notes.ts");
const { isSessionClosed } = await import("../src/core/native-messages.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const as = (m: unknown) => m as LhMessage;
const u = (id: string) => as({ role: "user", id, content: "hello" });
const a = (id: string) => as({ role: "assistant", id, content: [{ type: "text", text: "hi" }] });

function session(messages: LhMessage[]): string {
	const chat = stores.chatStore.createChat("Calculus");
	stores.chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

describe("closeWithoutNotes", () => {
	it("an unknown chat → 404", () => {
		const r = closeWithoutNotes("chat_missing");
		assert.equal(!r.ok && r.status, 404);
	});

	it("appends an empty boundary page and needs no model", () => {
		const id = session([u("m1"), a("m2")]);
		const r = closeWithoutNotes(id);
		assert.ok(r.ok);
		if (!r.ok) return;
		assert.equal(r.page.skipped, true);
		assert.equal(r.page.n, 1);
		assert.equal(r.page.toMessageId, "m2");
		assert.equal(stores.notesStore.readNotes(id)!.pages.length, 1);
	});

	it("closing again with nothing new is refused (409)", () => {
		const id = session([u("m1"), a("m2")]);
		assert.ok(closeWithoutNotes(id).ok);
		const again = closeWithoutNotes(id);
		assert.equal(!again.ok && again.status, 409);
		assert.equal(stores.notesStore.readNotes(id)!.pages.length, 1, "no second page");
	});

	it("an empty chat has nothing to close", () => {
		const id = session([]);
		assert.equal(closeWithoutNotes(id).ok, false);
	});

	it("after closing without notes, the next session can still be written up — as page 2", () => {
		const id = session([u("m1"), a("m2")]);
		assert.ok(closeWithoutNotes(id).ok);
		stores.chatStore.saveMessages(id, [u("m1"), a("m2"), u("m3"), a("m4")]);
		const saved = savePage(id, { draft: { summary: "Second session.", concepts: [{ title: "Limit", body: "what a limit is", refs: [] }] }, toMessageId: "m4" });
		assert.ok(saved.ok);
		if (!saved.ok) return;
		assert.equal(saved.page.n, 2, "one page per session, skipped or not");
		assert.equal(saved.page.concepts[0]!.n, 1, "concept numbering is untouched by the skipped page");
		assert.equal(saved.page.skipped, undefined);
	});

	it("a written page cannot reach back over a session that was already closed", () => {
		const id = session([u("m1"), a("m2"), u("m3"), a("m4")]);
		assert.ok(closeWithoutNotes(id).ok);
		const stale = savePage(id, { draft: { summary: "Old.", concepts: [] }, toMessageId: "m2" });
		assert.equal(!stale.ok && stale.code, "stale_draft");
	});
});

describe("the closed state (what the Start panel keys on)", () => {
	it("closing without notes leaves the closed marker at the end of the chat", () => {
		const id = session([u("m1"), a("m2")]);
		assert.equal(isSessionClosed(stores.chatStore.getChat(id)!.messages), false);
		assert.ok(closeWithoutNotes(id).ok);
		const messages = stores.chatStore.getChat(id)!.messages;
		assert.equal(isSessionClosed(messages), true);
		const marker = messages[messages.length - 1] as unknown as { customType: string; details: { pageNumber: number; notes: boolean } };
		assert.equal(marker.customType, "session-closed");
		assert.deepEqual(marker.details, { pageNumber: 1, notes: false });
	});

	it("writing the page closes it too, flagged as having notes", () => {
		const id = session([u("m1"), a("m2")]);
		const saved = savePage(id, { draft: { summary: "First.", concepts: [{ title: "Limit", body: "what a limit is", refs: [] }] }, toMessageId: "m2" });
		assert.ok(saved.ok);
		const messages = stores.chatStore.getChat(id)!.messages;
		const marker = messages[messages.length - 1] as unknown as { details: { pageNumber: number; notes: boolean } };
		assert.equal(isSessionClosed(messages), true);
		assert.deepEqual(marker.details, { pageNumber: 1, notes: true });
	});

	it("the marker itself is not new learner activity — closing twice is refused", () => {
		const id = session([u("m1"), a("m2")]);
		assert.ok(closeWithoutNotes(id).ok);
		assert.equal(closeWithoutNotes(id).ok, false);
		assert.equal(stores.notesStore.readNotes(id)!.pages.length, 1);
	});

	it("starting WITHOUT a warm-up ends the closed state with a started marker", () => {
		const id = session([u("m1"), a("m2")]);
		assert.ok(closeWithoutNotes(id).ok);
		assert.equal(startSessionWithoutWarmup(id).ok, true);
		const messages = stores.chatStore.getChat(id)!.messages;
		assert.equal(isSessionClosed(messages), false);
		assert.equal((messages[messages.length - 1] as unknown as { customType: string }).customType, "session-started");
	});

	it("starting a session that is not closed changes nothing", () => {
		const id = session([u("m1"), a("m2")]);
		const before = stores.chatStore.getChat(id)!.messages.length;
		assert.equal(startSessionWithoutWarmup(id).ok, true);
		assert.equal(stores.chatStore.getChat(id)!.messages.length, before);
	});

	it("the chat list names the closed sessions, so the sidebar can nest them", () => {
		const id = session([u("m1"), a("m2")]);
		assert.equal(stores.chatStore.listChats().find((c) => c.id === id)!.sessions, undefined, "none before the first close");
		assert.ok(closeWithoutNotes(id).ok);
		stores.chatStore.saveMessages(id, [...stores.chatStore.getChat(id)!.messages, u("m3"), a("m4")]);
		assert.ok(closeWithoutNotes(id).ok);
		const sessions = stores.chatStore.listChats().find((c) => c.id === id)!.sessions!;
		assert.deepEqual(sessions.map((s) => s.n), [1, 2]);
		assert.ok(sessions.every((s) => !Number.isNaN(Date.parse(s.at))));
	});

	it("an unknown chat → 404", () => {
		const r = startSessionWithoutWarmup("chat_missing");
		assert.equal(!r.ok && r.status, 404);
	});
});
