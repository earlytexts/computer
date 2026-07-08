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

/* ------------------------------ catalogue ------------------------------ */

export type AuthorMeta = {
  slug: string;
  forename: string;
  surname: string;
  title?: string; // honorific, e.g. "Lord Kames"
  birth?: number;
  death?: number;
  /** Earliest `firstPublished` across the author's works (derived by the
   * corpus); undefined if they have none. Authors are ordered by it. */
  firstPublished?: number;
  nationality?: string;
  sex?: string;
};

export type EditionMeta = {
  /** Author slugs, in title order; [0] is the primary (host) author. */
  authorSlugs: string[];
  workSlug: string;
  slug: string; // a year slug, e.g. "1757", "1742a"
  title: string;
  breadcrumb: string;
  /** Whether the text itself is present in the corpus (else a stub). */
  imported: boolean;
  published: number[];
  sourceUrl?: string;
  sourceDesc?: string;
};

export type WorkMeta = {
  /** Author slugs, in title order — the people who wrote it. A co-authored work
   * appears under each of these in the catalogue. */
  authorSlugs: string[];
  /** Identity slug for the work's id, paths, and URL: a single author's slug, or
   * a joint slug ("astell-norris") for a co-authored work. Not itself an author. */
  hostSlug: string;
  slug: string;
  title: string;
  breadcrumb: string;
  imported: boolean;
  /** Earliest publication year across all editions (derived by the corpus). */
  firstPublished: number;
  /** Slug of the canonical edition (the default when none is specified). */
  canonicalSlug: string;
  /**
   * Whether the work lists as its own text in indexes. False for a subwork
   * meant to surface only inside the collection(s) that borrow it; true (the
   * default) otherwise. The work is in the catalogue either way — this only
   * governs whether index listings show it on its own.
   */
  standalone: boolean;
  editions: EditionMeta[]; // dated editions, ascending by year
};

export type CatalogueAuthor = AuthorMeta & {
  works: WorkMeta[]; // ascending by first publication year
};

export type CatalogueResponse = {
  authors: CatalogueAuthor[]; // ascending by year of first publication
  /** Distinct edition slugs across the catalogue (for filter UIs). */
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
  /** Author slugs of this section (cascaded): one for a letter in a
   * correspondence, the work's authors elsewhere. Map to names via the
   * response's `authors`. */
  authors: string[];
  children: SectionSummary[];
};

/** A section with its text and (recursively) its descendants' text. */
export type SectionContent = {
  slug: string;
  path: string[];
  title: string;
  breadcrumb: string;
  imported: boolean;
  /** Author slugs of this section (cascaded); see SectionSummary.authors. */
  authors: string[];
  blocks: Block[];
  children: SectionContent[];
};

export type EditionResponse = {
  /** Every author of the work, in title order (one, or both of a correspondence). */
  authors: AuthorMeta[];
  work: WorkMeta;
  edition: EditionMeta;
  /** Which version the blocks below are resolved to. */
  version: Version;
  /** The edition's own blocks (title page etc.). */
  blocks: Block[];
  sections: SectionSummary[];
};

export type FullTextResponse = {
  /** Every author of the work, in title order (one, or both of a correspondence). */
  authors: AuthorMeta[];
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
  /** Every author of the work, in title order (one, or both of a correspondence). */
  authors: AuthorMeta[];
  work: WorkMeta;
  edition: EditionMeta;
  version: Version;
  section: {
    path: string[];
    title: string;
    breadcrumb: string;
    imported: boolean;
    /** Author slugs of this section (cascaded); map to names via `authors`. */
    authors: string[];
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
  /** Every author of the work, in title order (one, or both of a correspondence). */
  authors: AuthorMeta[];
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
  /** Every author of the work, in title order (one, or both of a correspondence). */
  authors: AuthorMeta[];
  work: WorkMeta;
  a: EditionMeta;
  b: EditionMeta;
  rows: AlignedRow[];
};

export type CompareSectionResponse = {
  /** Every author of the work, in title order (one, or both of a correspondence). */
  authors: AuthorMeta[];
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
  authors: string[]; // author slugs, in title order
  authorNames: string[]; // surnames, parallel to authors, for display
  hostSlug: string; // the work's identity slug for paths/URLs (joint if co-authored)
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
  authors: string[];
  /** The work's identity slug for paths/URLs (joint if co-authored); null for
   * the author grouping, where no single work is named. */
  hostSlug: string | null;
  work: string;
  edition: string | null; // null unless by="edition"
  count: number; // phrase occurrences in this group
  tokens: number; // total tokens in this group (denominator)
  relative: number; // occurrences per 1000 tokens, rounded to 1 decimal
};

export type FrequencyResponse = {
  q: string;
  groupBy: "author" | "work" | "edition";
  total: number; // sum of count across all groups
  results: FrequencyEntry[]; // sorted by count descending
};

/* ---------------------------- concordance ---------------------------- */

/** One occurrence of the phrase, shown keyword-in-context. */
export type ConcordanceLine = {
  authors: string[]; // author slugs, in title order
  authorNames: string[]; // surnames, parallel to authors, for display
  hostSlug: string; // the work's identity slug for paths/URLs (joint if co-authored)
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
  /** Half-width of the context window: words kept on each side of the keyword. */
  window: number;
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
export type KeyMode = "lemma" | "form" | "exact";

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
  /** Target scope: the author/work the keywords are distinctive of. */
  author: string | null;
  work: string | null;
  /** The edition universe both sides were drawn from. */
  editions: "canonical" | "all";
  /** A specific printing (year slug) the universe was pinned to, or null. */
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
  /** The edition universe the scope was drawn from. */
  editions: "canonical" | "all";
  /** A specific printing (year slug) the scope was pinned to, or null. */
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

/* ------------------------------ similar ------------------------------ */

/**
 * The granularity a similarity query works at, both for the target and for the
 * items returned: a single SECTION (one document), a whole EDITION (its sections
 * summed), or a whole WORK (its canonical edition's sections summed).
 */
export type SimilarLevel = "section" | "edition" | "work";

/** One corpus item lexically similar to the target. */
export type SimilarItem = {
  authors: string[]; // author slugs, in title order
  authorNames: string[]; // surnames, parallel to authors, for display
  hostSlug: string; // the work's identity slug for paths/URLs (joint if co-authored)
  work: string;
  workBreadcrumb: string;
  /** The edition (a year slug) for section/edition levels; null for work level. */
  edition: string | null;
  /** The section path for the section level; empty otherwise. */
  sectionPath: string[];
  /** The section title for the section level; null otherwise. */
  sectionTitle: string | null;
  /**
   * Cosine similarity to the target (0–1): higher is more alike. Opaque, like
   * the search score — the TF-IDF vectors it derives from never leave the server.
   */
  score: number;
};

export type SimilarResponse = {
  /** The granularity compared (target and results alike). */
  level: SimilarLevel;
  /** Echo of the target scope. */
  author: string | null;
  work: string | null;
  /** The target edition (a year slug), resolved to canonical when omitted. */
  edition: string | null;
  /** The target section path (section level only); empty otherwise. */
  sectionPath: string[];
  /**
   * Whether the target resolved to a non-empty vector. False means the
   * author/work/edition/section was not found or had no indexed text, so there
   * is nothing to compare and `results` is empty.
   */
  found: boolean;
  /** Number of rows returned. */
  total: number;
  /** Similar items, ranked by similarity descending; the target's own work is
   * never among them. */
  results: SimilarItem[];
};

/* ------------------------------- topics ------------------------------ */

/**
 * The granularity a topic-mix query works at: a single SECTION, a whole EDITION
 * (its sections aggregated), or a whole WORK (its canonical edition aggregated).
 * The same three levels as `similar`.
 */
export type TopicLevel = SimilarLevel;

/** One lemma of a topic's term distribution, with its weight in the topic (0–1). */
export type TopicTermWeight = {
  lemma: string;
  weight: number;
};

/** One corpus work where a topic is prominent (for tracing a topic). */
export type TopicProminentItem = {
  authors: string[]; // author slugs, in title order
  authorNames: string[]; // surnames, parallel to authors, for display
  hostSlug: string; // the work's identity slug for paths/URLs (joint if co-authored)
  work: string;
  workBreadcrumb: string;
  /** The work's canonical edition (a year slug). */
  edition: string;
  /** The topic's share of this work's content (0–1). */
  weight: number;
};

/** One topic of the model: its term distribution and where it is most prominent. */
export type TopicSummary = {
  /** Stable 0-based topic id. */
  id: number;
  /** A short label: the topic's top few lemmas, joined. */
  label: string;
  /** The topic's highest-weight lemmas, descending — what the topic is "about". */
  terms: TopicTermWeight[];
  /** The canonical-edition works this topic is most prominent in, descending. */
  prominent: TopicProminentItem[];
};

export type TopicsResponse = {
  /** Number of topics in the model. */
  k: number;
  /** Every topic, in id order. */
  topics: TopicSummary[];
};

/** One topic in a target's mix: the topic, plus its share of the target. */
export type TopicMixItem = {
  id: number;
  label: string;
  /** A few of the topic's top lemmas, for context. */
  terms: TopicTermWeight[];
  /** The topic's share of the target (0–1). */
  weight: number;
};

export type TopicMixResponse = {
  /** The granularity aggregated. */
  level: TopicLevel;
  /** Echo of the target scope. */
  author: string | null;
  work: string | null;
  /** The target edition (a year slug), resolved to canonical when omitted. */
  edition: string | null;
  /** The target section path (section level only); empty otherwise. */
  sectionPath: string[];
  /**
   * Whether the target resolved to a mix. False means the author/work/edition/
   * section was not found or had no indexed text, so `topics` is empty.
   */
  found: boolean;
  /** Number of topics returned (those with non-zero weight, capped by `limit`). */
  total: number;
  /** The target's topics, by descending weight. */
  topics: TopicMixItem[];
};

/* ------------------------------- errors ------------------------------ */

export type ErrorResponse = { error: string };

/* ------------------------- the Computer contract --------------------- */

/**
 * Request parameters for the search-family routes. Shared by every
 * implementation of `Computer` (the in-process core and the HTTP client) and by
 * the response builders, so the contract is described in exactly one place.
 */
/**
 * The two edition-scope options shared by the universe-filter routes (see
 * scope.ts): `editions` chooses the universe (one canonical printing per work,
 * the default, or every printing), `edition` names one specific printing and is
 * only valid together with `work`. They are mutually exclusive.
 *
 * A `work` scopes by containment: a composite work's scope includes every
 * edition borrowed into its in-scope editions, so scoping to a collection
 * reaches the subworks spliced into its text (whose hits still cite their own
 * work and edition).
 */
export type EditionScope = {
  /** One specific printing (a year slug); requires `work`. */
  edition?: string;
  /** The edition universe: "canonical" (default) or "all" printings. */
  editions?: "canonical" | "all";
};

export type SearchParams = EditionScope & {
  q: string;
  /** Type level to match at (default: "form", the tolerant level). */
  match?: MatchLevel;
  /** Require initial capitalisation to agree (default: ignore case). */
  caseSensitive?: boolean;
  /** Which text to search: edited reading text (default) or the original. */
  version?: "edited" | "original";
  author?: string;
  work?: string;
  page?: number;
  perPage?: number;
};

export type FrequencyParams = EditionScope & {
  q: string;
  /** Group occurrences by author, work, or edition (default: work). */
  groupBy?: "author" | "work" | "edition";
  match?: MatchLevel;
  caseSensitive?: boolean;
  version?: "edited" | "original";
  author?: string;
  work?: string;
};

export type ConcordanceParams = EditionScope & {
  q: string;
  /** Half-width of the context window, in words each side (default 6, max 25). */
  window?: number;
  /** Line order: corpus order (default) or by the nearest words on each side. */
  sort?: "position" | "left" | "right";
  match?: MatchLevel;
  caseSensitive?: boolean;
  version?: "edited" | "original";
  author?: string;
  work?: string;
  page?: number;
  perPage?: number;
};

export type KeywordsParams = EditionScope & {
  /** Target author: the keywords are distinctive of this author. */
  author?: string;
  /** Target work (within the author), narrowing the target further. */
  work?: string;
  /**
   * The edition universe both the target and the reference are drawn from is set
   * by `editions` ("canonical" default, or "all"); a specific `edition` printing
   * (with `work`) pins it to that one. The target is the author/work within the
   * universe; the reference is the rest of it.
   */
  /** Term grouping level (default "lemma"). */
  by?: KeyMode;
  /** Which text to count: edited reading text (default) or the original. */
  version?: "edited" | "original";
  /** Minimum target occurrences for a term to be scored (default 5). */
  min?: number;
  /** Maximum rows to return (default 50). */
  limit?: number;
};

export type SimilarParams = {
  /** Target author slug — the item to find lookalikes for lives here. */
  author?: string;
  /** Target work slug within the author. */
  work?: string;
  /**
   * Target edition (a year slug). Omit for the work's canonical edition. At the
   * "work" level it is ignored (the work is taken as a whole).
   */
  edition?: string;
  /**
   * Target section path (slugs from the edition root). Provide it for a section
   * comparison; omit it for an edition- or work-level comparison.
   */
  path?: string[];
  /**
   * Granularity of both the target and the results. Defaults to "section" when a
   * `path` is given, otherwise "edition".
   */
  level?: SimilarLevel;
  /** Maximum items to return (default 20, max 200). */
  limit?: number;
};

export type TopicsParams = {
  /** Top lemmas to report per topic (default 12, max 25). */
  terms?: number;
  /** Prominent works to report per topic (default 8, max 50). */
  works?: number;
};

export type TopicMixParams = {
  /** Target author slug — the item whose topic mix you want lives here. */
  author?: string;
  /** Target work slug within the author. */
  work?: string;
  /**
   * Target edition (a year slug). Omit for the work's canonical edition. At the
   * "work" level it is ignored (the work is taken as a whole).
   */
  edition?: string;
  /**
   * Target section path (slugs from the edition root). Provide it for a section
   * mix; omit it for an edition- or work-level mix.
   */
  path?: string[];
  /**
   * Granularity of the target. Defaults to "section" when a `path` is given,
   * otherwise "edition".
   */
  level?: TopicLevel;
  /** Maximum topics to return, by descending weight (default 10, max k). */
  limit?: number;
};

export type CollocationsParams = EditionScope & {
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
   * The edition universe the scope is drawn from is set by `editions`
   * ("canonical" default, or "all"); a specific `edition` printing (with `work`)
   * pins it to that one.
   */
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
 *
 * Two conventions run across the params, so the asymmetries are intentional, not
 * accidental:
 *   - Paging. Passage routes (search, concordance) page with `page`/`perPage`;
 *     ranked-list routes (keywords, collocations, similar, topics/mix) cap with
 *     `limit` and do not page; frequency returns every group.
 *   - Version. `version` is accepted wherever the text is read live (the reading
 *     routes and search/frequency/concordance/keywords). Routes backed by a
 *     prebuilt, edited-only index (collocations, similar, topics) omit it.
 */
export type Computer = {
  catalogue: () => Promise<CatalogueResponse>;
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
  /** Corpus items most lexically similar to a target (cosine over TF-IDF). */
  similar: (params: SimilarParams) => Promise<SimilarResponse>;
  /** The corpus's topic model: each topic's top terms and where it is prominent. */
  topics: (params: TopicsParams) => Promise<TopicsResponse>;
  /** A target's topic mix (NMF over the DTM): "what this work is about". */
  topicMix: (params: TopicMixParams) => Promise<TopicMixResponse>;
};
