/**
 * The HTTP API contract between the computer and its clients.
 *
 * This file is self-contained (it imports only @earlytexts/markit types) so
 * that clients can import it directly alongside the client in client.ts.
 * Sites map `@earlytexts/computer/` to this `src/` directory (see their
 * deno.json) rather than vendoring a copy.
 */

import type { Block } from "@earlytexts/markit";

/**
 * Editorial markup makes every edition two texts. `edited` is the curated
 * reading text (insertions kept, deletions dropped); `original` is the
 * printed text (deletions kept, insertions dropped); `both` returns the raw
 * markup — the within-edition diff, the same shape a cross-edition compare
 * produces. Retrieval defaults to `edited`; search and compare to `edited`
 * too (they do not take `both`).
 */
export type Version = "edited" | "original" | "both";

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
  slug: string; // a year slug, e.g. "1757", "1742a"
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
  /** Slug of the canonical edition (the default when none is specified). */
  canonicalSlug: string;
  editions: EditionMeta[]; // dated editions, ascending by year
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
  /** Which version the blocks below are resolved to. */
  version: Version;
  /** The edition's own blocks (title page etc.). */
  blocks: Block[];
  sections: SectionSummary[];
};

export type FullTextResponse = {
  author: AuthorMeta;
  work: WorkMeta;
  edition: EditionMeta;
  version: Version;
  blocks: Block[];
  sections: SectionContent[];
};

/** A neighbouring or enclosing section, for navigation. */
export type SectionRef = {
  path: string[];
  breadcrumb: string;
};

/**
 * An edition of the work that contains a given section, together with that
 * edition's own path to it (section slugs can differ across editions, e.g.
 * a year suffix). Lets a client link straight to the matching section in
 * another edition, or compare against it.
 */
export type EditionSection = {
  slug: string;
  path: string[];
};

export type SectionResponse = {
  author: AuthorMeta;
  work: WorkMeta;
  edition: EditionMeta;
  version: Version;
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
  /**
   * The work's other editions that contain a matching section, each with its
   * own path to it (for linking to that edition's section, or comparing).
   */
  compareEditions: EditionSection[];
};

export type SectionFullTextResponse = {
  author: AuthorMeta;
  work: WorkMeta;
  edition: EditionMeta;
  version: Version;
  /** The requested section with all its descendant blocks loaded. */
  section: SectionContent;
  ancestors: SectionRef[];
  prev?: SectionRef;
  next?: SectionRef;
  compareEditions: EditionSection[];
};

/* ------------------------------ compare ------------------------------ */

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
  /** Which version of each edition was compared (applied to both sides). */
  version: Version;
  title: string;
  /** This section's resolved path within edition A / edition B. */
  aPath: string[];
  bPath: string[];
  /**
   * The work's editions other than A and B that also contain this section,
   * each with its own path (for switching either side of the comparison).
   */
  compareEditions: EditionSection[];
  /**
   * Neighbouring sections (in edition A's reading order) that also exist in
   * edition B, so the comparison can be navigated section by section.
   */
  prev?: SectionRef;
  next?: SectionRef;
  /**
   * The diff as a Markit document: words and whole blocks present only in
   * edition A are wrapped in `deletion`, those only in B in `insertion`
   * (Markit's editorial markup, rendered like any other block). Render it
   * with the same component used for reading text — no diff-specific logic.
   */
  blocks: Block[];
  childRows: AlignedRow[];
};

/* ------------------------------- search ------------------------------ */

export type SearchResult = {
  author: string; // author slug
  authorName: string; // surname, for display
  work: string;
  workBreadcrumb: string;
  edition: string; // a year slug
  sectionPath: string[];
  sectionTitle: string;
  blockId: string;
  score: number;
  /**
   * The complete matched block, resolved to the searched version and fully
   * formatted, with the matched tokens wrapped in `highlight` inline
   * elements (rendered as <mark> by Markit's renderHTML). Render it like any
   * other block.
   */
  block: Block;
};

export type SearchResponse = {
  q: string;
  /**
   * The whole query is matched as one phrase. By default matching is tolerant
   * (case- and spelling-insensitive: old/modern spellings and inflections find
   * each other). `exactSpelling` matches the surface form as written;
   * `caseSensitive` requires each word's initial capitalisation to agree.
   */
  exactSpelling: boolean;
  caseSensitive: boolean;
  /** Which version was searched (`edited` default, or `original`). */
  version: Version;
  total: number;
  page: number;
  pages: number;
  results: SearchResult[];
};

/* ----------------------------- frequency ----------------------------- */

export type FrequencyEntry = {
  label: string;
  author: string;
  work: string;
  edition: string | null; // null unless by="edition"
  count: number; // phrase occurrences in this group
  tokens: number; // total tokens in this group (denominator)
  relative: number; // occurrences per 1000 tokens, rounded to 1 decimal
};

export type FrequencyResponse = {
  q: string;
  by: "author" | "work" | "edition";
  total: number; // sum of count across all groups
  results: FrequencyEntry[]; // sorted by count descending
};

/* ---------------------------- concordance ---------------------------- */

/** One occurrence of the phrase, shown keyword-in-context. */
export type ConcordanceLine = {
  author: string; // author slug
  authorName: string; // surname, for display
  work: string;
  workBreadcrumb: string;
  edition: string; // a year slug
  sectionPath: string[];
  sectionTitle: string;
  blockId: string;
  /** Context words to the left of the keyword, in reading order ("" at the
   * block's start). */
  left: string;
  /** The matched phrase, verbatim from the block's extracted text. */
  keyword: string;
  /** Context words to the right of the keyword, in reading order ("" at the
   * block's end). */
  right: string;
  /** True when context was cut at the word limit, not the block edge (so a UI
   * can show an ellipsis on that side). */
  leftTruncated: boolean;
  rightTruncated: boolean;
};

export type ConcordanceResponse = {
  q: string;
  /** Context words kept on each side of the keyword. */
  context: number;
  /** Line order: `position` (corpus order) or by the words nearest the keyword
   * on the `left` / `right`. */
  sort: "position" | "left" | "right";
  /** Matching options, as for search (the whole query is one phrase). */
  exactSpelling: boolean;
  caseSensitive: boolean;
  version: Version;
  total: number; // occurrences across the whole scope
  page: number;
  pages: number;
  lines: ConcordanceLine[];
};

/* ------------------------------- errors ------------------------------ */

export type ErrorResponse = { error: string };
