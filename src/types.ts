/**
 * The HTTP API contract between the computer and its clients.
 *
 * This file is self-contained (it imports only @earlytexts/markit types) so
 * that clients can vendor an identical copy. The davidhume site keeps one at
 * src/lib/types.ts; its `deno task contract` checks the two files are
 * byte-identical. Change them together.
 */

import type { Block } from "@earlytexts/markit";

/* ------------------------------ catalog ------------------------------ */

export type AuthorMeta = {
  slug: string;
  forename: string;
  surname: string;
  title?: string; // honorific, e.g. "Lord Kames"
  birth?: number;
  death?: number;
  published?: number; // year of first publication; authors are ordered by it
  nationality?: string;
  sex?: string;
};

export type EditionMeta = {
  authorSlug: string;
  workSlug: string;
  slug: string; // "main" for the main text, otherwise e.g. "1757", "1742a"
  isMain: boolean;
  title: string;
  breadcrumb: string;
  /** Whether the text itself is present in the corpus (else a stub). */
  imported: boolean;
  published: number[];
  copytext: string[];
  sourceUrl?: string;
  sourceDesc?: string;
};

export type WorkMeta = {
  authorSlug: string;
  slug: string;
  title: string;
  breadcrumb: string;
  imported: boolean;
  published: number[];
  editions: EditionMeta[]; // main edition first, then dated editions ascending
};

export type CatalogAuthor = AuthorMeta & {
  works: WorkMeta[]; // ascending by first publication year
};

export type CatalogResponse = {
  authors: CatalogAuthor[]; // ascending by year of first publication
  /** Distinct edition slugs across the catalog (for filter UIs). */
  editionSlugs: string[];
};

/* ------------------------------- texts ------------------------------- */

/** A section's place in an edition, without its text. */
export type SectionSummary = {
  slug: string;
  path: string[]; // slugs from the edition root down to this section
  title: string;
  breadcrumb: string;
  /** Whether this section's text is present (own value or inherited). */
  imported: boolean;
  children: SectionSummary[];
};

/** A section with its text and (recursively) its descendants' text. */
export type SectionContent = {
  slug: string;
  path: string[];
  title: string;
  breadcrumb: string;
  imported: boolean;
  blocks: Block[];
  children: SectionContent[];
};

export type EditionResponse = {
  author: AuthorMeta;
  work: WorkMeta;
  edition: EditionMeta;
  /** The edition's own blocks (title page etc.). */
  blocks: Block[];
  sections: SectionSummary[];
};

export type FullTextResponse = {
  author: AuthorMeta;
  work: WorkMeta;
  edition: EditionMeta;
  blocks: Block[];
  sections: SectionContent[];
};

/** A neighbouring or enclosing section, for navigation. */
export type SectionRef = {
  path: string[];
  breadcrumb: string;
};

export type SectionResponse = {
  author: AuthorMeta;
  work: WorkMeta;
  edition: EditionMeta;
  section: {
    path: string[];
    title: string;
    breadcrumb: string;
    imported: boolean;
    blocks: Block[];
    children: SectionSummary[];
  };
  ancestors: SectionRef[];
  prev?: SectionRef;
  next?: SectionRef;
  /** Slugs of the work's other editions that contain a matching section. */
  compareEditions: string[];
};

/* ------------------------------ compare ------------------------------ */

export type Token = {
  text: string;
  /** Whether the token was preceded by whitespace in the source. */
  spaced: boolean;
};

export type DiffOp = {
  type: "equal" | "delete" | "insert";
  tokens: Token[];
};

export type BlockDiff =
  | { type: "equal"; id: string; a: Block; b: Block }
  | { type: "changed"; id: string; a: Block; b: Block; ops: DiffOp[] }
  | { type: "deleted"; id: string; a: Block }
  | { type: "inserted"; id: string; b: Block };

/**
 * Two editions' section trees aligned in reading order. A row missing
 * `pathA` exists only in edition B, and vice versa.
 */
export type AlignedRow = {
  key: string;
  title: string;
  pathA?: string[];
  pathB?: string[];
  children: AlignedRow[];
};

export type CompareResponse = {
  author: AuthorMeta;
  work: WorkMeta;
  a: EditionMeta;
  b: EditionMeta;
  rows: AlignedRow[];
};

export type CompareSectionResponse = {
  author: AuthorMeta;
  work: WorkMeta;
  a: EditionMeta;
  b: EditionMeta;
  title: string;
  diffs: BlockDiff[];
  childRows: AlignedRow[];
};

/* ------------------------------- search ------------------------------ */

export type SnippetPart = { text: string; marked: boolean };

export type SearchResult = {
  author: string; // author slug
  authorName: string; // surname, for display
  work: string;
  workBreadcrumb: string;
  edition: string; // "main" or a year slug
  sectionPath: string[];
  sectionTitle: string;
  blockId: string;
  score: number;
  snippet: SnippetPart[];
};

export type SearchResponse = {
  q: string;
  total: number;
  page: number;
  pages: number;
  results: SearchResult[];
};

/* ------------------------------- errors ------------------------------ */

export type ErrorResponse = { error: string };
