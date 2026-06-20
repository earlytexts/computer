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

/**
 * Which type level a query word is matched at, coarsest last:
 *  - `exact`    the surface as written;
 *  - `spelling` any spelling of the same form (orthography-tolerant);
 *  - `form`     any inflection too (the tolerant default).
 */
export type MatchLevel = "exact" | "spelling" | "form";

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
   * The whole query is matched as one phrase. `match` selects the type level:
   * `form` (default) unites old/modern spellings and inflections, `spelling`
   * only spellings, `exact` the surface as written. `caseSensitive` requires
   * each word's initial capitalisation to agree.
   */
  match: MatchLevel;
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
  match: MatchLevel;
  caseSensitive: boolean;
  version: Version;
  total: number; // occurrences across the whole scope
  page: number;
  pages: number;
  lines: ConcordanceLine[];
};

/* ------------------------------ keywords ----------------------------- */

/** The level terms are grouped and reported at, coarsest first. */
export type KeyMode = "lemma" | "form" | "surface";

/** One term over-represented in the target subcorpus. */
export type KeywordEntry = {
  /** The lemma, form bucket, or surface form (per `by`). */
  term: string;
  /** Occurrences in the target subcorpus. */
  target: number;
  /** Occurrences in the reference subcorpus. */
  reference: number;
  /** Target occurrences per 1000 tokens (rounded to 1 decimal). */
  targetRelative: number;
  /** Reference occurrences per 1000 tokens (rounded to 1 decimal). */
  referenceRelative: number;
  /**
   * Dunning's log-likelihood (G²): how much evidence there is that the term's
   * rate differs between target and reference. Significance, not effect size —
   * read it with `logRatio`.
   */
  logLikelihood: number;
  /** log₂ of the relative-frequency ratio (target / reference): the effect size. */
  logRatio: number;
};

export type KeywordsResponse = {
  /** The level terms were grouped at. */
  by: KeyMode;
  /** Which text was counted (`edited` default, or `original`). */
  version: "edited" | "original";
  /** Target scope: the author/work/edition the keywords are distinctive of. */
  author: string | null;
  work: string | null;
  /** Edition universe: a year slug, "all", or null for canonical editions. */
  edition: string | null;
  /** Total tokens in the target subcorpus (the rate denominator). */
  targetTokens: number;
  /** Total tokens in the reference subcorpus (the rest of the universe). */
  referenceTokens: number;
  /** Number of rows returned. */
  total: number;
  /** Over-represented terms, ranked by log-likelihood descending. */
  results: KeywordEntry[];
};

/* ---------------------------- collocations --------------------------- */

/** One word that occurs near the node word more (or less) than chance. */
export type CollocationEntry = {
  /** The lemma, form bucket, or surface form (per `by`). */
  term: string;
  /** Times the collocate falls within the node's window (the co-occurrence). */
  cooccurrence: number;
  /** The collocate's total occurrences in the scope. */
  total: number;
  /** Co-occurrences per 1000 node-window tokens (rounded to 1 decimal). */
  relative: number;
  /**
   * Pointwise mutual information (log₂ observed/expected): the effect size.
   * Favours rare, tightly-bound pairs — the vivid lexical neighbours.
   */
  pmi: number;
  /**
   * Dunning's log-likelihood (G²): the strength of evidence that the pairing
   * is non-random. The default ranking; favours confident, frequent collocates.
   */
  logLikelihood: number;
  /** t-score ((O−E)/√O): frequency-weighted confidence, the companion to PMI. */
  tScore: number;
};

export type CollocationsResponse = {
  /** The node word, as queried. */
  q: string;
  /** The level collocates were grouped at. */
  by: KeyMode;
  /** How strictly the node word was matched. */
  match: MatchLevel;
  /** Half-width of the context window, in tokens (the span is ±window). */
  window: number;
  /** Scope: the author/work the collocations were measured within (or null). */
  author: string | null;
  work: string | null;
  /** Edition scope: a year slug, "all", or null for canonical editions. */
  edition: string | null;
  /** Total tokens in the scope (N). */
  scopeTokens: number;
  /** Occurrences of the node word in scope. */
  nodeCount: number;
  /** Context positions examined across all node windows (the rate denominator). */
  windowTokens: number;
  /** Number of rows returned. */
  total: number;
  /** Collocates, ranked by log-likelihood descending. */
  results: CollocationEntry[];
};

/* ------------------------------- errors ------------------------------ */

export type ErrorResponse = { error: string };

/* ------------------------- the Computer contract --------------------- */

/**
 * Request parameters for the search-family routes. Shared by every
 * implementation of `Computer` (the in-process core and the HTTP client) and by
 * the response builders, so the contract is described in exactly one place.
 */
export type SearchParams = {
  q: string;
  /** Type level to match at (default: "form", the tolerant level). */
  match?: MatchLevel;
  /** Require initial capitalisation to agree (default: ignore case). */
  caseSensitive?: boolean;
  /** Which text to search: edited reading text (default) or the original. */
  version?: "edited" | "original";
  author?: string;
  work?: string;
  edition?: string;
  page?: number;
  perPage?: number;
};

export type FrequencyParams = {
  q: string;
  /** Group occurrences by author, work, or edition (default: work). */
  by?: "author" | "work" | "edition";
  match?: MatchLevel;
  caseSensitive?: boolean;
  version?: "edited" | "original";
  author?: string;
  work?: string;
  edition?: string;
};

export type ConcordanceParams = {
  q: string;
  /** Context words on each side of the keyword (default 6, max 25). */
  context?: number;
  /** Line order: corpus order (default) or by the nearest words on each side. */
  sort?: "position" | "left" | "right";
  match?: MatchLevel;
  caseSensitive?: boolean;
  version?: "edited" | "original";
  author?: string;
  work?: string;
  edition?: string;
  page?: number;
  perPage?: number;
};

export type KeywordsParams = {
  /** Target author: the keywords are distinctive of this author. */
  author?: string;
  /** Target work (within the author), narrowing the target further. */
  work?: string;
  /**
   * Edition universe both sides are drawn from: a year slug, "all" for every
   * printing, or omitted for canonical editions only (the default). The target
   * is the author/work within this universe; the reference is the rest of it.
   */
  edition?: string;
  /** Term grouping level (default "lemma"). */
  by?: KeyMode;
  /** Which text to count: edited reading text (default) or the original. */
  version?: "edited" | "original";
  /** Minimum target occurrences for a term to be scored (default 5). */
  min?: number;
  /** Maximum rows to return (default 50). */
  limit?: number;
};

export type CollocationsParams = {
  /** The node word whose collocates you want. */
  q: string;
  /** Collocate grouping level (default "lemma"). */
  by?: KeyMode;
  /** How strictly to match the node word (default "form", the tolerant level). */
  match?: MatchLevel;
  /** Half-width of the context window, in tokens (default 5, max 25). */
  window?: number;
  /** Minimum co-occurrence count for a collocate to be scored (default 3). */
  min?: number;
  /** Maximum rows to return (default 50, max 500). */
  limit?: number;
  /** Scope to one author. */
  author?: string;
  /** Scope to one work (within the author). */
  work?: string;
  /**
   * Edition universe the scope is drawn from: a year slug, "all" for every
   * printing, or omitted for canonical editions only (the default).
   */
  edition?: string;
};

/**
 * The computer's core interface: every read/search/diff/frequency function over
 * the corpus. It is the keystone contract, with two peer implementations — the
 * in-process core over the artefacts (`localComputer`) and the HTTP client that
 * unwraps the wire (`computerClient` in client.ts) — and it is what the HTTP and
 * MCP servers are written against, agnostic to which implementation they hold.
 *
 * Read methods return `undefined` for a missing author/work/edition/section (the
 * caller renders its own not-found); the search family always returns a result.
 */
export type Computer = {
  catalog: () => Promise<CatalogResponse>;
  /** Omit `edition` to address the work's canonical edition. */
  edition: (
    author: string,
    work: string,
    edition?: string,
    version?: Version,
  ) => Promise<EditionResponse | undefined>;
  fullText: (
    author: string,
    work: string,
    edition?: string,
    version?: Version,
  ) => Promise<FullTextResponse | undefined>;
  section: (
    author: string,
    work: string,
    edition: string | undefined,
    path: string[],
    version?: Version,
  ) => Promise<SectionResponse | undefined>;
  sectionFullText: (
    author: string,
    work: string,
    edition: string | undefined,
    path: string[],
    version?: Version,
  ) => Promise<SectionFullTextResponse | undefined>;
  compare: (
    author: string,
    work: string,
    a: string,
    b: string,
  ) => Promise<CompareResponse | undefined>;
  compareSection: (
    author: string,
    work: string,
    a: string,
    b: string,
    path: string[],
    version?: Version,
  ) => Promise<CompareSectionResponse | undefined>;
  search: (params: SearchParams) => Promise<SearchResponse>;
  frequency: (params: FrequencyParams) => Promise<FrequencyResponse>;
  concordance: (params: ConcordanceParams) => Promise<ConcordanceResponse>;
  /** Words a target subcorpus uses more than the rest of the corpus (keyness). */
  keywords: (params: KeywordsParams) => Promise<KeywordsResponse>;
  /** Words that occur near a node word more than chance (collocation). */
  collocations: (params: CollocationsParams) => Promise<CollocationsResponse>;
};
