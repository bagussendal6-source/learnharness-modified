/**
 * Book-index contracts — what a roadmap folder keeps about each textbook after
 * its one-time ingest. The book is read ONCE; everything a session may ever
 * need (page text, the table-of-contents tree, the printed-page numbering) is
 * saved here, and no session re-scans or re-sends a whole book.
 *
 * Pages are always the PDF's own 1-based page numbers (the roadmap's anchors
 * use them). The number PRINTED on the page is a different thing — front
 * matter shifts it — so the manifest carries the way to compute it.
 */

export const BOOK_FORMAT_VERSION = 1;

/** One table-of-contents entry with the page span it covers. Flat list in
 *  outline order; `depth` 0 = a top-level entry. The span runs to the page
 *  before the next entry of the same or a shallower depth. */
export interface BookOutlineNode {
	id: string;
	title: string;
	depth: number;
	startPage: number;
	endPage: number;
}

/** One page's saved text (pages.json). `img` is how many images the page
 *  draws (figures, photos); `bad` marks text whose formulas/symbols came out
 *  garbled, so the page should be LOOKED AT (rendered) rather than trusted. */
export interface BookPage {
	p: number;
	text: string;
	img: number;
	bad?: boolean;
}

/** data/roadmaps/<folderId>/books/<bookId>/manifest.json */
export interface BookManifest {
	version: number;
	id: string;
	/** Short handle the roadmap uses for the book ("mankiw"); set when a
	 *  roadmap's book label is matched to this file, absent until then. */
	key?: string;
	/** The file's name as the learner had it. */
	sourceName: string;
	/** The PDF's own title metadata, when it has one. */
	title: string | null;
	sha256: string;
	bytes: number;
	pages: number;
	indexedAt: string;
	/** printed page = pdf page − pageOffset, when the book has no page labels
	 *  and the offset could be detected; null when it could not. */
	pageOffset: number | null;
	/** 0–1: the share of sampled pages that agreed on `pageOffset`. */
	offsetConfidence: number;
	/** The PDF's own page labels (one per page), when it carries them. They
	 *  win over `pageOffset`. */
	labels: string[] | null;
	outlineEntries: number;
	/** Page numbers whose extracted text is unreliable (garbled formulas). */
	badPages: number[];
	/** Pages that draw at least one image. */
	figurePages: number;
}

/** A search hit. `printed` is the page number as printed in the book (null in
 *  the front matter or when unknown); `page` is the PDF page. */
export interface BookHit {
	book: string;
	page: number;
	printed: string | null;
	score: number;
	snippet: string;
}
