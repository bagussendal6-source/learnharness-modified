/**
 * Attached sources live IN the message string as trailing `Source file: <path>`
 * lines (so every send path and the agent stay unchanged); the UI only hides
 * them behind name chips. These two functions are the whole contract:
 * join(split(v).text, split(v).files) === v for strings join produced.
 */
export interface SourceFile { path: string; name: string }

const LINE = /^Source file: (.+)$/;
/** Uploaded copies are stored as "<8 hex>-<original name>"; show the original. */
export function sourceName(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	// A converted deck is stored as "<id>-<deck>.pptx.pdf"; show the deck the learner picked.
	return base.replace(/^[0-9a-f]{8}-/, "").replace(/(\.pptx?)\.pdf$/i, "$1");
}

export function splitSources(value: string): { text: string; files: SourceFile[] } {
	const files: SourceFile[] = [];
	const rest: string[] = [];
	for (const line of value.split("\n")) {
		const match = LINE.exec(line);
		if (match) files.push({ path: match[1]!, name: sourceName(match[1]!) });
		else rest.push(line);
	}
	// join() ends the block with a newline; that empty tail is not user text.
	if (files.length > 0 && rest.length > 1 && rest[rest.length - 1] === "") rest.pop();
	return { text: rest.join("\n"), files };
}

export function joinSources(text: string, files: SourceFile[]): string {
	if (files.length === 0) return text;
	return `${text}\n${files.map((f) => `Source file: ${f.path}`).join("\n")}\n`;
}

/** "very-long-lecture-notes-2024.pdf" → "very-long-lectu…2024.pdf" past 30 chars. */
export function shortName(name: string, max = 30): string {
	if (name.length <= max) return name;
	const keep = max - 1, tail = Math.ceil(keep / 2), head = keep - tail;
	return `${name.slice(0, head)}…${name.slice(-tail)}`;
}
