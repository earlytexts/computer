/**
 * Pure builders for every API response: each takes the loaded artefacts (the
 * catalogue metadata tree and, where block text is needed, a BlockStore that
 * reads it from blocks.jsonl) plus request parameters, and returns a
 * serializable value from types.ts, or undefined for "not found". The HTTP
 * server is a thin shell around these.
 */

import type { Block } from "@earlytexts/markit";
import type {
  CatalogueArtefact,
  EditionEntry,
  ServeArtefacts,
  SkeletonSection,
  WorkEntry,
} from "../artefacts.ts";
import {
  aggregateMix,
  type AlignedSection,
  alignSections,
  collocations,
  compareLines,
  diffBlocks,
  diffToBlocks,
  extractText,
  findSectionByKey,
  highlight,
  IN_SCOPE,
  type KeyMode,
  keyness,
  lineParts,
  type MatchLevel,
  matchRanges,
  occurrences,
  parseQuery,
  REFERENCE,
  resolveBlock,
  scopeEditions,
  search,
  type SearchOptions,
  similar,
  type Sort,
  surfaceIds,
  TARGET,
  tokenize,
} from "../text/mod.ts";
import {
  type BlockStore,
  type DtmStore,
  findEditionEntry,
  type TokenStore,
  type TopicsStore,
} from "./store.ts";
import { editionFilter, resolveEditions } from "../../scope.ts";
import type {
  AlignedRow,
  AuthorMeta,
  CatalogueResponse,
  CollocationEntry,
  CollocationsParams,
  CollocationsResponse,
  CompareResponse,
  CompareSectionResponse,
  ConcordanceLine,
  ConcordanceParams,
  ConcordanceResponse,
  EditionResponse,
  EditionSection,
  FrequencyEntry,
  FrequencyParams,
  FrequencyResponse,
  FullTextResponse,
  KeywordsParams,
  KeywordsResponse,
  SearchParams,
  SearchResponse,
  SectionContent,
  SectionFullTextResponse,
  SectionRef,
  SectionResponse,
  SectionSummary,
  SimilarItem,
  SimilarLevel,
  SimilarParams,
  SimilarResponse,
  TopicLevel,
  TopicMixItem,
  TopicMixParams,
  TopicMixResponse,
  TopicsParams,
  TopicsResponse,
  TopicSummary,
  TopicTermWeight,
  Version,
} from "../../types.ts";

/* --------------------------- skeleton helpers ------------------------- */

const sectionSummary = (section: SkeletonSection): SectionSummary => ({
  slug: section.slug,
  path: section.path,
  title: section.title,
  breadcrumb: section.breadcrumb,
  imported: section.imported,
  authors: section.authors,
  children: section.children.map(sectionSummary),
});

const sectionContent = async (
  store: BlockStore,
  section: SkeletonSection,
  version: Version,
): Promise<SectionContent> => ({
  slug: section.slug,
  path: section.path,
  title: section.title,
  breadcrumb: section.breadcrumb,
  imported: section.imported,
  authors: section.authors,
  blocks: (await store.blocks(section.units))
    .map((block) => resolveBlock(block, version)),
  children: await Promise.all(
    section.children.map((child) => sectionContent(store, child, version)),
  ),
});

const sectionRef = (section: SkeletonSection): SectionRef => ({
  path: section.path,
  breadcrumb: section.breadcrumb,
});

/** Find a section in an edition's skeleton by its slug path. */
const findSkeleton = (
  sections: SkeletonSection[],
  path: string[],
): SkeletonSection | undefined => {
  let current = sections;
  let found: SkeletonSection | undefined;
  for (const slug of path) {
    found = current.find((s) => s.slug === slug.toLowerCase());
    if (found === undefined) return undefined;
    current = found.children;
  }
  return found;
};

/** Depth-first flattening of a skeleton (for prev/next navigation). */
const flattenSkeleton = (sections: SkeletonSection[]): SkeletonSection[] =>
  sections.flatMap((s) => [s, ...flattenSkeleton(s.children)]);

const alignedRow = (row: AlignedSection): AlignedRow => ({
  key: row.key,
  title: row.title,
  pathA: row.a?.path,
  pathB: row.b?.path,
  children: row.children.map(alignedRow),
});

/**
 * The work's other editions that contain a section matching `keys`, each with
 * its own path to it — for linking to, or comparing against, the same section in
 * another printing. `exclude` is the edition(s) already in hand.
 */
const matchingEditions = (
  work: WorkEntry,
  exclude: EditionEntry[],
  path: string[],
): EditionSection[] =>
  work.editions
    .filter((other) => !exclude.includes(other))
    .flatMap((other) => {
      const match = findSectionByKey(other.sections, path);
      return match === undefined
        ? []
        : [{ slug: other.meta.slug, path: match.path }];
    });

/**
 * A section's place for navigation: its ancestors (root-down) and the sections
 * immediately before and after it in the edition's reading order. Shared by the
 * section and section-full-text responses.
 */
const sectionNav = (
  edition: EditionEntry,
  section: SkeletonSection,
): { ancestors: SectionRef[]; prev?: SectionRef; next?: SectionRef } => {
  const flat = flattenSkeleton(edition.sections);
  const index = flat.findIndex((s) =>
    s.path.join("/") === section.path.join("/")
  );
  const ancestors = section.path.slice(0, -1)
    .map((_slug, i) =>
      findSkeleton(edition.sections, section.path.slice(0, i + 1))
    )
    .filter((s): s is SkeletonSection => s !== undefined)
    .map(sectionRef);
  return {
    ancestors,
    prev: flat[index - 1] === undefined
      ? undefined
      : sectionRef(flat[index - 1]),
    next: flat[index + 1] === undefined
      ? undefined
      : sectionRef(flat[index + 1]),
  };
};

/* ------------------------------ builders ----------------------------- */

export const catalogueResponse = (
  catalogue: CatalogueArtefact,
): CatalogueResponse => ({
  authors: catalogue.authors.map((author) => ({
    ...author.meta,
    works: author.works.map((work) => work.meta),
  })),
  editionSlugs: catalogue.editionSlugs,
});

export const editionResponse = async (
  store: BlockStore,
  authors: AuthorMeta[],
  work: WorkEntry,
  edition: EditionEntry,
  version: Version = "edited",
): Promise<EditionResponse> => ({
  authors,
  work: work.meta,
  edition: edition.meta,
  version,
  blocks: (await store.blocks(edition.units))
    .map((block) => resolveBlock(block, version)),
  sections: edition.sections.map(sectionSummary),
});

export const fullTextResponse = async (
  store: BlockStore,
  authors: AuthorMeta[],
  work: WorkEntry,
  edition: EditionEntry,
  version: Version = "edited",
): Promise<FullTextResponse> => ({
  authors,
  work: work.meta,
  edition: edition.meta,
  version,
  blocks: (await store.blocks(edition.units))
    .map((block) => resolveBlock(block, version)),
  sections: await Promise.all(
    edition.sections.map((section) => sectionContent(store, section, version)),
  ),
});

export const sectionResponse = async (
  store: BlockStore,
  authors: AuthorMeta[],
  work: WorkEntry,
  edition: EditionEntry,
  path: string[],
  version: Version = "edited",
): Promise<SectionResponse | undefined> => {
  const section = findSkeleton(edition.sections, path);
  if (section === undefined) return undefined;

  const { ancestors, prev, next } = sectionNav(edition, section);
  return {
    authors,
    work: work.meta,
    edition: edition.meta,
    version,
    section: {
      path: section.path,
      title: section.title,
      breadcrumb: section.breadcrumb,
      imported: section.imported,
      authors: section.authors,
      blocks: (await store.blocks(section.units))
        .map((block) => resolveBlock(block, version)),
      children: section.children.map(sectionSummary),
    },
    ancestors,
    prev,
    next,
    compareEditions: matchingEditions(work, [edition], section.path),
  };
};

export const sectionFullTextResponse = async (
  store: BlockStore,
  authors: AuthorMeta[],
  work: WorkEntry,
  edition: EditionEntry,
  path: string[],
  version: Version = "edited",
): Promise<SectionFullTextResponse | undefined> => {
  const skeleton = findSkeleton(edition.sections, path);
  if (skeleton === undefined) return undefined;

  const { ancestors, prev, next } = sectionNav(edition, skeleton);
  return {
    authors,
    work: work.meta,
    edition: edition.meta,
    version,
    section: await sectionContent(store, skeleton, version),
    ancestors,
    prev,
    next,
    compareEditions: matchingEditions(work, [edition], skeleton.path),
  };
};

export const compareResponse = (
  authors: AuthorMeta[],
  work: WorkEntry,
  aSlug: string,
  bSlug: string,
): CompareResponse | undefined => {
  const a = findEditionEntry(work, aSlug);
  const b = findEditionEntry(work, bSlug);
  if (a === undefined || b === undefined || a === b) return undefined;
  return {
    authors,
    work: work.meta,
    a: a.meta,
    b: b.meta,
    rows: alignSections(a.sections, b.sections).map(alignedRow),
  };
};

export const compareSectionResponse = async (
  store: BlockStore,
  authors: AuthorMeta[],
  work: WorkEntry,
  aSlug: string,
  bSlug: string,
  path: string[],
  version: Version = "edited",
): Promise<CompareSectionResponse | undefined> => {
  const a = findEditionEntry(work, aSlug);
  const b = findEditionEntry(work, bSlug);
  if (a === undefined || b === undefined || a === b) return undefined;
  const sectionA = findSectionByKey(a.sections, path);
  const sectionB = findSectionByKey(b.sections, path);
  if (sectionA === undefined || sectionB === undefined) return undefined;
  const [blocksA, blocksB] = await Promise.all([
    store.blocks(sectionA.units),
    store.blocks(sectionB.units),
  ]);
  // Resolve each edition to the chosen version first, then diff: the markup
  // in the result expresses the A↔B difference, not either edition's own
  // corrections (which the resolution has already applied). A is the primary
  // edition being viewed, so it takes the insertion side (and B the deletion
  // side): diffBlocks marks text only in its first argument as deletions, so B
  // goes first and A second.
  const diffs = diffBlocks(
    blocksB.map((block) => resolveBlock(block, version)),
    blocksA.map((block) => resolveBlock(block, version)),
  );

  // Other editions of the work that also contain this section, for switching
  // either side of the comparison.
  const compareEditions = matchingEditions(work, [a, b], path);

  // Step through edition A's reading order to the nearest neighbour that also
  // exists in edition B, so the next/prev comparison can never 404.
  const flatA = flattenSkeleton(a.sections);
  const index = flatA.findIndex((s) =>
    s.path.join("/") === sectionA.path.join("/")
  );
  const neighbourInBoth = (step: number): SectionRef | undefined => {
    for (let i = index + step; i >= 0 && i < flatA.length; i += step) {
      const candidate = flatA[i];
      if (findSectionByKey(b.sections, candidate.path) !== undefined) {
        return sectionRef(candidate);
      }
    }
    return undefined;
  };

  return {
    authors,
    work: work.meta,
    a: a.meta,
    b: b.meta,
    version,
    title: sectionB.title,
    aPath: sectionA.path,
    bPath: sectionB.path,
    compareEditions,
    prev: neighbourInBoth(-1),
    next: neighbourInBoth(1),
    blocks: diffToBlocks(diffs),
    childRows: alignSections(sectionA.children, sectionB.children)
      .map(alignedRow),
  };
};

/* ------------------------------- search ------------------------------ */

/** Resolve the request's `match` level; defaults to tolerant. */
const parseMatch = (match?: MatchLevel): MatchLevel => match ?? "form";

/** The live-text version: the original when asked, else the edited reading text. */
const parseVersion = (
  version?: "edited" | "original",
): "edited" | "original" => version ?? "edited";

/**
 * Resolve a count parameter to a whole number: the request value (already
 * validated as a positive integer at the boundary) or `def`, floored at 1 and —
 * when given — capped at `max`. This is where the documented maxima are enforced,
 * so an over-cap value is clamped rather than rejected.
 */
const clamp = (raw: number | undefined, def: number, max?: number): number => {
  const n = Math.max(1, Math.floor(raw ?? def));
  return max === undefined ? n : Math.min(max, n);
};

/**
 * Whether an edition falls in the chosen universe: its canonical printing by
 * default (`filter` undefined), every printing (`filter === "all"`), or the one
 * named year (the `edition`/`editions` params, resolved to a `filter` by
 * scope.ts). Keywords' reference universe reads this flag directly; the
 * author/work-scoped side of every route goes through `scopeEditions`, which
 * adds borrowed containment on top of the same rule.
 */
const inUniverse = (
  filter: string | undefined,
  canonical: boolean,
  edition: string,
): boolean =>
  filter === undefined ? canonical : filter === "all" || edition === filter;

/**
 * Project an edition-indexed label array onto the unit-indexed scope array the
 * pure text routines (keyness, collocations) consume: each unit takes its
 * edition's label (0 for out of scope, or a route's TARGET/REFERENCE/IN_SCOPE).
 */
const labelUnits = (
  editionOf: ArrayLike<number>,
  editionLabel: ArrayLike<number>,
): Int8Array => {
  const scope = new Int8Array(editionOf.length);
  for (let unit = 0; unit < scope.length; unit++) {
    scope[unit] = editionLabel[editionOf[unit]];
  }
  return scope;
};

const MAX_PER_PAGE = 100;

/**
 * The citation fields shared by a search result and a concordance line: who
 * wrote the matched block and where it sits. Read from the edition manifest and
 * the unit tables by the hit's unit index.
 */
const citation = (artefacts: ServeArtefacts, unitIndex: number) => {
  const { units, manifest } = artefacts;
  const ref = manifest.editions[units.edition[unitIndex]];
  const sectionPath = units.sectionPath[unitIndex];
  return {
    authors: ref.authors,
    authorNames: ref.authorNames,
    hostSlug: ref.hostSlug,
    work: ref.work,
    workBreadcrumb: ref.workBreadcrumb,
    edition: ref.edition,
    sectionPath: sectionPath === "" ? [] : sectionPath.split("/"),
    sectionTitle: units.sectionTitle[unitIndex],
    blockId: units.blockId[unitIndex],
  };
};

/**
 * Slice a ranked list to one page: the page's items, the page number, and the
 * total page count (at least 1). Shared by search and concordance.
 */
const paginate = <T>(
  items: T[],
  page: number,
  perPage: number,
): { items: T[]; page: number; pages: number } => ({
  items: items.slice((page - 1) * perPage, page * perPage),
  page,
  pages: Math.max(1, Math.ceil(items.length / perPage)),
});

export const frequencyResponse = (
  artefacts: ServeArtefacts,
  params: FrequencyParams,
): FrequencyResponse => {
  const q = params.q.trim();
  const filter = editionFilter(params);
  const groupBy = params.groupBy ?? "work";
  const options: SearchOptions = {
    match: parseMatch(params.match),
    caseSensitive: params.caseSensitive ?? false,
    resolved: false, // frequency counts wide (recall over every reading)
  };
  const version: Version = parseVersion(params.version);
  const hits = q === "" ? [] : search(
    artefacts,
    q,
    { author: params.author, work: params.work, edition: filter },
    options,
    version,
  );

  // Each phrase match contributes phraseLength positions; dividing recovers
  // the occurrence count without re-running phrase matching.
  const phraseLength = Math.max(1, parseQuery(artefacts, q).length);
  const { units, manifest, editionUnits } = artefacts;

  // Total token count per edition index (summed once, reused across groups).
  const editionTokenCounts = manifest.editions.map((_, i) =>
    editionUnits[i].reduce((s, u) => s + units.tokenCount[u], 0)
  );

  type GroupData = {
    count: number;
    tokens: number;
    label: string;
    authors: string[];
    hostSlug: string | null;
    work: string;
    edition: string | null;
  };
  const groups = new Map<string, GroupData>();

  // The groups an edition feeds. Grouping by author splits a co-authored edition
  // across each of its authors (one row apiece, no single work named); grouping
  // by work/edition keys on the work's host slug, so the work stays a single row
  // carrying all its authors.
  type Contribution = {
    key: string;
    label: string;
    authors: string[];
    hostSlug: string | null;
    work: string;
    edition: string | null;
  };
  const contributions = (
    ref: typeof manifest.editions[number],
  ): Contribution[] =>
    groupBy === "author"
      ? ref.authors.map((slug, i) => ({
        key: slug,
        label: ref.authorNames[i],
        authors: [slug],
        hostSlug: null,
        work: ref.work,
        edition: null,
      }))
      : [{
        key: groupBy === "edition"
          ? `${ref.hostSlug}/${ref.work}/${ref.edition}`
          : `${ref.hostSlug}/${ref.work}`,
        label: groupBy === "edition"
          ? `${ref.workBreadcrumb} (${ref.edition})`
          : ref.workBreadcrumb,
        authors: ref.authors,
        hostSlug: ref.hostSlug,
        work: ref.work,
        edition: groupBy === "edition" ? ref.edition : null,
      }];

  // First pass: count occurrences per group from hits.
  for (const hit of hits) {
    const ref = manifest.editions[units.edition[hit.unitIndex]];
    const count = Math.round(hit.positions.length / phraseLength);
    for (const c of contributions(ref)) {
      if (!groups.has(c.key)) {
        groups.set(c.key, {
          count: 0,
          tokens: 0,
          label: c.label,
          authors: c.authors,
          hostSlug: c.hostSlug,
          work: c.work,
          edition: c.edition,
        });
      }
      groups.get(c.key)!.count += count;
    }
  }

  // Second pass: sum in-scope token counts as the relative-frequency denominator.
  // Resolved by the same scope rule as search() (borrowed containment included),
  // so numerators and denominators agree.
  const inScope = scopeEditions(manifest.editions, {
    author: params.author,
    work: params.work,
    edition: filter,
  });
  for (let i = 0; i < manifest.editions.length; i++) {
    if (inScope[i] === 0) continue;
    for (const c of contributions(manifest.editions[i])) {
      const group = groups.get(c.key);
      if (group !== undefined) group.tokens += editionTokenCounts[i];
    }
  }

  const results: FrequencyEntry[] = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => ({
      label: g.label,
      authors: g.authors,
      hostSlug: g.hostSlug,
      work: g.work,
      edition: g.edition,
      count: g.count,
      tokens: g.tokens,
      // A group only exists because an in-scope edition matched, and the second
      // pass adds that edition's (non-zero) token count, so tokens > 0 here.
      relative: Math.round((g.count / g.tokens) * 10000) / 10,
    }));

  return {
    q,
    groupBy,
    total: results.reduce((s, r) => s + r.count, 0),
    results,
  };
};

/* ------------------------------ keywords ----------------------------- */

const MAX_KEYWORDS = 500;
const DEFAULT_KEYWORDS = 50;
const DEFAULT_MIN_COUNT = 5;

const parseMode = (by?: KeyMode): KeyMode => by ?? "lemma";

// Every caller has already established a non-zero token denominator (keywords
// bails when either side has no tokens; collocations only reports a node that
// occurs, which always has context tokens), so the division is always defined.
const per1000 = (count: number, tokens: number): number =>
  Math.round((count / tokens) * 10000) / 10;

/**
 * Keyness: the terms a target subcorpus uses more than the rest of the corpus.
 * The target is the author/work named in `params`; the reference is the rest of
 * the edition universe (canonical editions by default, or the `edition` scope) —
 * so every unit is partitioned into target, reference, or out of scope, and
 * `keyness` scores the difference. With no author there is no target, so the
 * result is empty (as an empty query is for the search family).
 */
export const keywordsResponse = (
  artefacts: ServeArtefacts,
  params: KeywordsParams,
): KeywordsResponse => {
  const mode = parseMode(params.by);
  const version = parseVersion(params.version);
  const minCount = clamp(params.min, DEFAULT_MIN_COUNT);
  const limit = clamp(params.limit, DEFAULT_KEYWORDS, MAX_KEYWORDS);
  const editionScope = editionFilter(params);
  const empty: KeywordsResponse = {
    by: mode,
    version,
    author: params.author ?? null,
    work: params.work ?? null,
    editions: resolveEditions(params),
    edition: params.edition ?? null,
    targetTokens: 0,
    referenceTokens: 0,
    total: 0,
    results: [],
  };
  // No target, no keywords (a target is an author, optionally narrowed to a work).
  if (params.author === undefined) return empty;

  const { manifest, units } = artefacts;
  // Classify each edition once (target / reference / out), then label its
  // units. The target resolves by the shared scope rule (scopeEditions), so
  // naming a collection targets the editions borrowed into it too; the
  // reference is the rest of the edition universe.
  const target = scopeEditions(manifest.editions, {
    author: params.author,
    work: params.work,
    edition: editionScope,
  });
  const editionClass = manifest.editions.map((ref, i) =>
    target[i] === 1
      ? TARGET
      : inUniverse(editionScope, ref.canonical, ref.edition)
      ? REFERENCE
      : 0
  );
  const scope = labelUnits(units.edition, editionClass);

  const result = keyness(artefacts, scope, { mode, version, minCount, limit });
  return {
    by: mode,
    version,
    author: params.author, // narrowed to a string by the guard above
    work: params.work ?? null,
    editions: resolveEditions(params),
    edition: params.edition ?? null,
    targetTokens: result.targetTokens,
    referenceTokens: result.referenceTokens,
    total: result.rows.length,
    results: result.rows.map((row) => ({
      term: row.term,
      target: row.target,
      reference: row.reference,
      targetRelative: per1000(row.target, result.targetTokens),
      referenceRelative: per1000(row.reference, result.referenceTokens),
      logLikelihood: row.logLikelihood,
      logRatio: row.logRatio,
    })),
  };
};

/* ---------------------------- collocations --------------------------- */

const MAX_COLLOCATIONS = 500;
const DEFAULT_COLLOCATIONS = 50;
const DEFAULT_COLLOCATION_MIN = 3;
const DEFAULT_WINDOW = 5;
const MAX_WINDOW = 25;

/**
 * Collocations: the words that occur near a node word more than chance. The
 * node word is resolved to its surface ids at the requested match level; the
 * scope (the corpus of canonical editions by default, or the author/work/
 * edition named in `params`) fixes which units count. Marginal frequencies come
 * from the inverted index over that scope, but the windows are positional, so
 * the node word's in-scope units are read from the ordered token stream and
 * walked here before the pure `collocations` scores every collocate.
 */
export const collocationsResponse = async (
  tokens: TokenStore,
  artefacts: ServeArtefacts,
  params: CollocationsParams,
): Promise<CollocationsResponse> => {
  const q = params.q.trim();
  const mode = parseMode(params.by);
  const match = parseMatch(params.match);
  const window = clamp(params.window, DEFAULT_WINDOW, MAX_WINDOW);
  const minCount = clamp(params.min, DEFAULT_COLLOCATION_MIN);
  const limit = clamp(params.limit, DEFAULT_COLLOCATIONS, MAX_COLLOCATIONS);
  const editionScope = editionFilter(params);
  const empty: CollocationsResponse = {
    q,
    by: mode,
    match,
    window,
    author: params.author ?? null,
    work: params.work ?? null,
    editions: resolveEditions(params),
    edition: params.edition ?? null,
    scopeTokens: 0,
    nodeCount: 0,
    windowTokens: 0,
    total: 0,
    results: [],
  };
  if (q === "") return empty;

  // The node word's surfaces, united across the query's words at the match level.
  const nodeSurfaces = new Set<number>();
  for (const word of parseQuery(artefacts, q)) {
    for (const id of surfaceIds(artefacts, word.surface, match)) {
      nodeSurfaces.add(id);
    }
  }
  if (nodeSurfaces.size === 0) return empty;

  const { manifest, units, postings } = artefacts;
  // Classify each edition once (in scope / out), then label its units. The
  // scope resolves by the same rule as search/keywords (scopeEditions):
  // canonical editions by default, or the named edition slug ("all" for every
  // printing), with a work filter reaching its borrowed editions.
  const editionMask = scopeEditions(manifest.editions, {
    author: params.author,
    work: params.work,
    edition: editionScope,
  });
  const editionLabel = manifest.editions.map((_, i) =>
    editionMask[i] === 1 ? IN_SCOPE : 0
  );
  const scope = labelUnits(units.edition, editionLabel);

  // The in-scope units that contain the node word — the only ones whose token
  // streams must be read (windows never reach beyond a unit).
  const nodeUnitIndices = new Set<number>();
  for (const id of nodeSurfaces) {
    for (
      let i = postings.offsets[id] * 2;
      i < postings.offsets[id + 1] * 2;
      i += 2
    ) {
      const unit = postings.pairs[i];
      if (scope[unit] === IN_SCOPE) nodeUnitIndices.add(unit);
    }
  }
  const nodeUnits = new Map<number, Uint32Array>();
  await Promise.all(
    [...nodeUnitIndices].map(async (unit) => {
      nodeUnits.set(unit, await tokens.unitSurfaces(unit));
    }),
  );

  const result = collocations(artefacts, scope, nodeSurfaces, nodeUnits, {
    mode,
    window,
    minCount,
    limit,
  });
  return {
    q,
    by: mode,
    match,
    window,
    author: params.author ?? null,
    work: params.work ?? null,
    editions: resolveEditions(params),
    edition: params.edition ?? null,
    scopeTokens: result.scopeTokens,
    nodeCount: result.nodeCount,
    windowTokens: result.windowTokens,
    total: result.rows.length,
    results: result.rows.map((row): CollocationEntry => ({
      term: row.term,
      cooccurrence: row.cooccurrence,
      total: row.total,
      relative: per1000(row.cooccurrence, result.windowTokens),
      pmi: row.pmi,
      logLikelihood: row.logLikelihood,
      tScore: row.tScore,
    })),
  };
};

/* ------------------------------ similar ------------------------------ */

const MAX_SIMILAR = 200;
const DEFAULT_SIMILAR = 20;

const parseLevel = (
  level: SimilarLevel | undefined,
  hasPath: boolean,
): SimilarLevel => level ?? (hasPath ? "section" : "edition");

/**
 * Resolve a similarity/topic target's edition: the named printing, or the work's
 * canonical edition when omitted (the work level always takes the canonical
 * printing). Returns the edition's manifest index and its year slug, or undefined
 * when the author/work/edition is absent. Shared by `similar` and `topicMix`.
 */
const resolveTargetEdition = (
  manifest: ServeArtefacts["manifest"],
  author: string,
  work: string,
  level: SimilarLevel,
  edition?: string,
): { index: number; slug: string } | undefined => {
  const want = level === "work" ? undefined : edition;
  const index = manifest.editions.findIndex((ref) =>
    ref.authors.includes(author) && ref.work === work &&
    (want === undefined ? ref.canonical : ref.edition === want)
  );
  return index === -1
    ? undefined
    : { index, slug: manifest.editions[index].edition };
};

/**
 * The document rows making up a target: the one matching section at the section
 * level, or every section of the target edition at the edition/work level (the
 * caller aggregates them). Works over either the DTM's or the topic model's docs.
 */
const targetDocs = (
  docs: ArrayLike<{ edition: number; sectionPath: string }>,
  edition: number,
  level: SimilarLevel,
  sectionKey: string,
): number[] => {
  const rows: number[] = [];
  for (let d = 0; d < docs.length; d++) {
    if (docs[d].edition !== edition) continue;
    if (level === "section" && docs[d].sectionPath !== sectionKey) continue;
    rows.push(d);
  }
  return rows;
};

/**
 * Similarity: the corpus items most lexically like a target, by cosine over the
 * TF-IDF document vectors (the DTM artefact, read lazily here). The target is an
 * author/work, narrowed to an edition (canonical by default) and — at the section
 * level — a section path; coarser levels sum their constituent document rows. The
 * result universe is the canonical editions (one printing per work, as the other
 * routes default), with the target's own work excluded, so the answer is "what
 * ELSE in the corpus reads like this". Pure scoring lives in `similar`; here we
 * resolve the target's rows, partition the universe into candidate items, and
 * label the ranked rows.
 */
export const similarResponse = async (
  dtmStore: DtmStore,
  artefacts: ServeArtefacts,
  params: SimilarParams,
): Promise<SimilarResponse> => {
  const requestPath = params.path ?? [];
  const level = parseLevel(params.level, requestPath.length > 0);
  const limit = clamp(params.limit, DEFAULT_SIMILAR, MAX_SIMILAR);
  // The section path matters only at the section level; lowercase it to match
  // the stored slugs (as the text routes do).
  const sectionPath = level === "section"
    ? requestPath.map((slug) => slug.toLowerCase())
    : [];

  const notFound: SimilarResponse = {
    level,
    author: params.author ?? null,
    work: params.work ?? null,
    edition: params.edition ?? null,
    sectionPath,
    found: false,
    total: 0,
    results: [],
  };
  if (params.author === undefined || params.work === undefined) return notFound;

  const { manifest, units } = artefacts;
  // Resolve the target edition (the named one, or the canonical default), then
  // its document rows; the work level takes the canonical printing as the result
  // universe does.
  const target = resolveTargetEdition(
    manifest,
    params.author,
    params.work,
    level,
    params.edition,
  );
  if (target === undefined) return notFound;

  const dtm = await dtmStore.matrix();
  const docs = targetDocs(dtm.docs, target.index, level, sectionPath.join("/"));
  // Found only if the target carries indexed text (a non-empty vector).
  const found = docs.some((d) => dtm.rowPtr[d] < dtm.rowPtr[d + 1]);
  if (!found) return notFound;

  // Section titles, for labelling section-level results.
  const titleOf = new Map<string, string>();
  if (level === "section") {
    for (let u = 0; u < units.edition.length; u++) {
      const key = `${units.edition[u]}\t${units.sectionPath[u]}`;
      if (!titleOf.has(key)) titleOf.set(key, units.sectionTitle[u]);
    }
  }

  // Candidate items: documents of the canonical editions (the result universe),
  // minus the target work, grouped at the chosen level. `labels` runs parallel
  // to `groupDocs`; the pure scorer returns group indices into both.
  const groupDocs: number[][] = [];
  const labels: SimilarItem[] = [];
  const groupOf = new Map<string, number>();
  for (let d = 0; d < dtm.docs.length; d++) {
    const ref = manifest.editions[dtm.docs[d].edition];
    if (!ref.canonical) continue;
    if (ref.authors.includes(params.author) && ref.work === params.work) {
      continue;
    }
    const key = level === "work"
      ? `${ref.hostSlug}/${ref.work}`
      : level === "edition"
      ? `${dtm.docs[d].edition}`
      : `${d}`;
    let g = groupOf.get(key);
    if (g === undefined) {
      g = groupDocs.length;
      groupOf.set(key, g);
      groupDocs.push([]);
      const docPath = dtm.docs[d].sectionPath;
      labels.push({
        authors: ref.authors,
        authorNames: ref.authorNames,
        hostSlug: ref.hostSlug,
        work: ref.work,
        workBreadcrumb: ref.workBreadcrumb,
        edition: level === "work" ? null : ref.edition,
        sectionPath: level === "section"
          ? (docPath === "" ? [] : docPath.split("/"))
          : [],
        // Every section has a unit, and titleOf is keyed off those units, so a
        // section-level doc always has a title (the builder falls back to the
        // section id when none is given).
        sectionTitle: level === "section"
          ? titleOf.get(`${dtm.docs[d].edition}\t${docPath}`)!
          : null,
        score: 0,
      });
    }
    groupDocs[g].push(d);
  }

  const ranked = similar(dtm, docs, groupDocs, { limit });
  const results = ranked.map((row) => ({
    ...labels[row.group],
    score: row.score,
  }));
  return {
    level,
    author: params.author,
    work: params.work,
    edition: level === "work" ? null : target.slug,
    sectionPath,
    found: true,
    total: results.length,
    results,
  };
};

/* ------------------------------ topics ------------------------------- */

const MAX_TOPIC_TERMS = 25; // matches the per-topic terms stored at build time
const DEFAULT_TOPIC_TERMS = 12;
const MAX_PROMINENT_WORKS = 50;
const DEFAULT_PROMINENT_WORKS = 8;
const DEFAULT_MIX_TOPICS = 10;
const MIX_CONTEXT_TERMS = 6; // top terms shown beside a topic in a mix

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** A topic's short label: its top few lemmas, joined. */
const topicLabel = (terms: { lemma: string }[]): string =>
  terms.slice(0, 3).map((term) => term.lemma).join(", ");

/** Round a stored term distribution to the wire shape, capping the term count. */
const wireTerms = (
  terms: { lemma: string; weight: number }[],
  count: number,
): TopicTermWeight[] =>
  terms.slice(0, count)
    .map((term) => ({ lemma: term.lemma, weight: round4(term.weight) }))
    .filter((term) => term.weight > 0);

/**
 * The corpus's topic model: every topic with its highest-weight terms (what the
 * topic is about) and the canonical-edition works it is most prominent in (so a
 * client can trace a topic across authors and decades). The model is trained at
 * build time (NMF over the DTM, read lazily here); this only labels and ranks.
 * Works are grouped from the document mix and each aggregated once, then ranked
 * per topic by that work's share of the topic.
 */
export const topicsResponse = async (
  topicsStore: TopicsStore,
  artefacts: ServeArtefacts,
  params: TopicsParams,
): Promise<TopicsResponse> => {
  const model = await topicsStore.model();
  const { manifest } = artefacts;
  const nTerms = clamp(params.terms, DEFAULT_TOPIC_TERMS, MAX_TOPIC_TERMS);
  const nWorks = clamp(
    params.works,
    DEFAULT_PROMINENT_WORKS,
    MAX_PROMINENT_WORKS,
  );

  // Group the canonical-edition documents by work, then aggregate each work's
  // topic mix once (reused across all topics). `labels` runs parallel to the
  // groups.
  const groupDocs: number[][] = [];
  const labels: {
    authors: string[];
    authorNames: string[];
    hostSlug: string;
    work: string;
    workBreadcrumb: string;
    edition: string;
  }[] = [];
  const groupOf = new Map<string, number>();
  for (let d = 0; d < model.docs.length; d++) {
    const ref = manifest.editions[model.docs[d].edition];
    if (!ref.canonical) continue;
    const key = `${ref.hostSlug}/${ref.work}`;
    let g = groupOf.get(key);
    if (g === undefined) {
      g = groupDocs.length;
      groupOf.set(key, g);
      groupDocs.push([]);
      labels.push({
        authors: ref.authors,
        authorNames: ref.authorNames,
        hostSlug: ref.hostSlug,
        work: ref.work,
        workBreadcrumb: ref.workBreadcrumb,
        edition: ref.edition,
      });
    }
    groupDocs[g].push(d);
  }
  const workMix = groupDocs.map((docs) => aggregateMix(model, docs));

  const topics: TopicSummary[] = [];
  for (let t = 0; t < model.k; t++) {
    const prominent = workMix
      .map((mix, g) => ({ g, weight: round4(mix[t]) }))
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.g - b.g)
      .slice(0, nWorks)
      .map((entry) => ({ ...labels[entry.g], weight: entry.weight }));
    topics.push({
      id: t,
      label: topicLabel(model.terms[t]),
      terms: wireTerms(model.terms[t], nTerms),
      prominent,
    });
  }
  return { k: model.k, topics };
};

/**
 * A target's topic mix — "what this work is about". The target is an author/work,
 * narrowed by edition (canonical by default) and, at the section level, a path;
 * coarser levels aggregate their constituent document mixes. Returns the topics
 * the target carries, by descending share, each tagged with a few top terms for
 * context. Mirrors `similarResponse`'s target resolution; the aggregation is the
 * pure `aggregateMix`.
 */
export const topicMixResponse = async (
  topicsStore: TopicsStore,
  artefacts: ServeArtefacts,
  params: TopicMixParams,
): Promise<TopicMixResponse> => {
  const requestPath = params.path ?? [];
  const level: TopicLevel = parseLevel(params.level, requestPath.length > 0);
  const sectionPath = level === "section"
    ? requestPath.map((slug) => slug.toLowerCase())
    : [];

  const notFound: TopicMixResponse = {
    level,
    author: params.author ?? null,
    work: params.work ?? null,
    edition: params.edition ?? null,
    sectionPath,
    found: false,
    total: 0,
    topics: [],
  };
  if (params.author === undefined || params.work === undefined) return notFound;

  const { manifest } = artefacts;
  const target = resolveTargetEdition(
    manifest,
    params.author,
    params.work,
    level,
    params.edition,
  );
  if (target === undefined) return notFound;

  const model = await topicsStore.model();
  const docs = targetDocs(
    model.docs,
    target.index,
    level,
    sectionPath.join("/"),
  );

  const mix = aggregateMix(model, docs);
  let sum = 0;
  for (let t = 0; t < model.k; t++) sum += mix[t];
  if (sum === 0) return notFound; // no indexed text → no mix

  const limit = clamp(params.limit, DEFAULT_MIX_TOPICS, model.k);
  const topics: TopicMixItem[] = Array.from(
    { length: model.k },
    (_, t) => ({ t, weight: round4(mix[t]) }),
  )
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.t - b.t)
    .slice(0, limit)
    .map((entry) => ({
      id: entry.t,
      label: topicLabel(model.terms[entry.t]),
      terms: wireTerms(model.terms[entry.t], MIX_CONTEXT_TERMS),
      weight: entry.weight,
    }));

  return {
    level,
    author: params.author,
    work: params.work,
    edition: level === "work" ? null : target.slug,
    sectionPath,
    found: true,
    total: topics.length,
    topics,
  };
};

export const searchResponse = async (
  store: BlockStore,
  artefacts: ServeArtefacts,
  params: SearchParams,
): Promise<SearchResponse> => {
  const q = params.q.trim();
  const options: SearchOptions = {
    match: parseMatch(params.match),
    caseSensitive: params.caseSensitive ?? false,
    resolved: params.resolved ?? false,
  };
  const version: Version = parseVersion(params.version);
  const page = clamp(params.page, 1);
  const perPage = clamp(params.perPage, 20, MAX_PER_PAGE);
  const hits = q === "" ? [] : search(
    artefacts,
    q,
    {
      author: params.author,
      work: params.work,
      edition: editionFilter(params),
    },
    options,
    version,
  );
  const { items: pageHits, pages } = paginate(hits, page, perPage);
  return {
    q,
    match: options.match,
    caseSensitive: options.caseSensitive,
    resolved: options.resolved,
    version,
    total: hits.length,
    page,
    pages,
    results: await Promise.all(pageHits.map(async (hit) => {
      // Positions index into the version's tokenization; markit's highlight
      // resolves the block to that version and injects the marks in one walk.
      const block: Block = await store.unitBlock(hit.unitIndex);
      const ranges = matchRanges(block, hit.positions, version);
      return {
        ...citation(artefacts, hit.unitIndex),
        score: hit.score,
        block: highlight(block, ranges, version),
      };
    })),
  };
};

/* ---------------------------- concordance ---------------------------- */

// The concordance context window defaults wider than the collocation window
// (more context aids reading; MAX_WINDOW, the ±25 cap, is shared with it).
const DEFAULT_CONCORDANCE_WINDOW = 6;

/**
 * Keyword-in-context lines for a phrase: one line per occurrence (not per
 * block), each with a trimmed window of context on either side. Reuses search's
 * matching, edition scoping, and version handling, then expands every hit's
 * matched positions into occurrences. Sorting by the words nearest the keyword
 * needs the whole occurrence list, so all matched blocks are read before the
 * page is sliced (the block store's cache absorbs the repeated reads).
 */
export const concordanceResponse = async (
  store: BlockStore,
  artefacts: ServeArtefacts,
  params: ConcordanceParams,
): Promise<ConcordanceResponse> => {
  const q = params.q.trim();
  const options: SearchOptions = {
    match: parseMatch(params.match),
    caseSensitive: params.caseSensitive ?? false,
    resolved: false, // concordance reads wide (every reading of the phrase)
  };
  const version: Version = parseVersion(params.version);
  const sort: Sort = params.sort ?? "position";
  const window = clamp(params.window, DEFAULT_CONCORDANCE_WINDOW, MAX_WINDOW);
  const page = clamp(params.page, 1);
  const perPage = clamp(params.perPage, 20, MAX_PER_PAGE);
  const phraseLen = Math.max(1, parseQuery(artefacts, q).length);
  const hits = q === "" ? [] : search(
    artefacts,
    q,
    {
      author: params.author,
      work: params.work,
      edition: editionFilter(params),
    },
    options,
    version,
  );

  // Carry the sort keys and corpus position alongside each line, then strip
  // them off after ordering and paginating.
  type Built = ConcordanceLine & {
    unitIndex: number;
    start: number;
    leftWords: string[];
    rightWords: string[];
  };
  const built: Built[] = [];
  for (const hit of hits) {
    const block = await store.unitBlock(hit.unitIndex);
    // One tokenizer end to end: markit's tokens index the same extracted text
    // the build recorded positions against.
    const text = extractText(block, { version }).text;
    const tokens = tokenize(block, { version });
    const cite = citation(artefacts, hit.unitIndex);
    for (const start of occurrences(hit.positions, phraseLen)) {
      const parts = lineParts(text, tokens, start, phraseLen, window);
      built.push({
        ...cite,
        left: parts.left,
        keyword: parts.keyword,
        right: parts.right,
        leftTruncated: parts.leftTruncated,
        rightTruncated: parts.rightTruncated,
        unitIndex: hit.unitIndex,
        start,
        leftWords: parts.leftWords,
        rightWords: parts.rightWords,
      });
    }
  }

  built.sort(compareLines(sort));
  const { items: pageBuilt, pages } = paginate(built, page, perPage);
  const lines = pageBuilt.map(
    ({ unitIndex: _u, start: _s, leftWords: _l, rightWords: _r, ...line }) =>
      line,
  );
  return {
    q,
    window,
    sort,
    match: options.match,
    caseSensitive: options.caseSensitive,
    version,
    total: built.length,
    page,
    pages,
    lines,
  };
};
