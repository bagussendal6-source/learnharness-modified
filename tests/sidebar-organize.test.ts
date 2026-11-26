/**
 * The sidebar's list shaping (src/core/organize.ts): which sessions each filter
 * shows, how final exams nest under the session they examine, and the
 * optimistic folder move behind drag-and-drop. Pure — no DOM, no server.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dropChangesFolder, matchesKindFilter, nestExams, SESSION_DRAG_TYPE, withFolder } from "../src/core/organize.ts";

interface Item {
	id: string;
	kind?: string;
	folder?: string;
	exam?: { parentChatId: string; total: number };
}
const teach = (id: string, folder?: string): Item => ({ id, ...(folder ? { folder } : {}) });
const practice = (id: string): Item => ({ id, kind: "practice" });
const exam = (id: string, parent: string): Item => ({ id, kind: "practice", exam: { parentChatId: parent, total: 8 } });

describe("matchesKindFilter", () => {
	const all = [teach("t"), practice("p"), exam("e", "t")];
	const ids = (f: Parameters<typeof matchesKindFilter>[1]) => all.filter((c) => matchesKindFilter(c, f)).map((c) => c.id);

	it("all shows everything", () => assert.deepEqual(ids("all"), ["t", "p", "e"]));
	it("teaching shows only teaching sessions", () => assert.deepEqual(ids("teach"), ["t"]));
	it("practice never includes a final exam (it is practice-kind underneath)", () => assert.deepEqual(ids("practice"), ["p"]));
	it("exam shows only final exams", () => assert.deepEqual(ids("exam"), ["e"]));
	it("an absent kind reads as teaching (pre-practice records)", () => assert.equal(matchesKindFilter({}, "teach"), true));
});

describe("nestExams", () => {
	it("an exam sits under its parent and leaves the top level", () => {
		const { top, examsByParent } = nestExams([teach("a"), exam("e1", "a"), teach("b")]);
		assert.deepEqual(top.map((i) => i.id), ["a", "b"]);
		assert.deepEqual(examsByParent.get("a")!.map((i) => i.id), ["e1"]);
	});

	it("several attempts keep their order", () => {
		const { examsByParent } = nestExams([teach("a"), exam("e1", "a"), exam("e2", "a")]);
		assert.deepEqual(examsByParent.get("a")!.map((i) => i.id), ["e1", "e2"]);
	});

	it("an exam whose parent is NOT in the list stays top-level — never hidden", () => {
		const { top, examsByParent } = nestExams([exam("orphan", "gone"), teach("a")]);
		assert.deepEqual(top.map((i) => i.id), ["orphan", "a"]);
		assert.equal(examsByParent.size, 0);
	});

	it("ordinary and practice sessions are never nested", () => {
		const { top } = nestExams([teach("a"), practice("p")]);
		assert.equal(top.length, 2);
	});

	it("an empty list is fine", () => {
		const { top, examsByParent } = nestExams<Item>([]);
		assert.deepEqual(top, []);
		assert.equal(examsByParent.size, 0);
	});
});

describe("withFolder (the optimistic move)", () => {
	const list = [teach("a"), teach("b", "Fisika")];

	it("files a session into a folder, touching nothing else", () => {
		const next = withFolder(list, "a", "Kalkulus II");
		assert.equal(next[0]!.folder, "Kalkulus II");
		assert.equal(next[1], list[1], "other items keep their identity");
		assert.equal(list[0]!.folder, undefined, "the input is not mutated");
	});

	it("null unfiles (the field is removed, not set to null)", () => {
		const next = withFolder(list, "b", null);
		assert.equal("folder" in next[1]!, false);
	});

	it("normalizes the name like the server (trim, collapse spaces)", () => {
		assert.equal(withFolder(list, "a", "  Kalkulus   II ")[0]!.folder, "Kalkulus II");
	});

	it("an empty name unfiles", () => {
		assert.equal("folder" in withFolder(list, "b", "   ")[1]!, false);
	});

	it("an unknown id changes nothing", () => {
		assert.deepEqual(withFolder(list, "zzz", "X"), list);
	});
});

describe("dropChangesFolder", () => {
	it("dropping where it already is is a no-op (case-insensitive), null = unfiled", () => {
		assert.equal(dropChangesFolder({ folder: "Fisika" }, "fisika"), false);
		assert.equal(dropChangesFolder({}, null), false);
		assert.equal(dropChangesFolder({ folder: "Fisika" }, "Kalkulus"), true);
		assert.equal(dropChangesFolder({}, "Kalkulus"), true);
		assert.equal(dropChangesFolder({ folder: "Fisika" }, null), true);
	});

	it("an unknown session never fires a request", () => {
		assert.equal(dropChangesFolder(undefined, "X"), false);
	});
});

describe("the drag type", () => {
	it("is a custom MIME type, so OS files and text never read as a session move", () => {
		assert.match(SESSION_DRAG_TYPE, /^application\/x-lh-/);
	});
});
