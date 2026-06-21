/**
 * Pure builders for every API response: each takes the loaded artefacts (the
 * catalog metadata tree and, where block text is needed, a BlockStore that
 * reads it from blocks.jsonl) plus request parameters, and returns a
 * serializable value from types.ts, or undefined for "not found". The HTTP
 * server is a thin shell around these.
 */

import type { Block } from "@earlytexts/markit";
import {
  type AuthorEntry,
  type CatalogArtefact,
  type EditionEntry,
  type ServeArtefacts,
  type SkeletonSection,
  type WorkEntry,
} from "../artefacts.ts";
import {
  aggregateMix,
  type AlignedSection,
  alignSections,
  blockText,
  collocations,
  compareLines,
  diffBlocks,
  diffToBlocks,
  findSectionByKey,
  highlightBlock,
  IN_SCOPE,
  type KeyMode,
  keyness,
  lineParts,
  type MatchLevel,
  matchRanges,
  occurrences,
  parseQuery,
  pathKey,
  REFERENCE,
  resolveBlock,
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
import type {
  AlignedRow,
  CatalogResponse,
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

/* ------------------------------ builders ----------------------------- */

export const catalogResponse = (catalog: CatalogArtefact): CatalogResponse => ({
  authors: catalog.authors.map((author) => ({
    ...author.meta,
    works: author.works.map((work) => work.meta),
  })),
  editionSlugs: catalog.editionSlugs,
});

export const editionResponse = async (
  store: BlockStore,
  author: AuthorEntry,
  work: WorkEntry,
  edition: EditionEntry,
  version: Version = "edited",
): Promise<EditionResponse> => ({
  author: author.meta,
  work: work.meta,
  edition: edition.meta,
  version,
  blocks: (await store.blocks(edition.units))
    .map((block) => resolveBlock(block, version)),
  sections: edition.sections.map(sectionSummary),
});

export const fullTextResponse = async (
  store: BlockStore,
  author: AuthorEntry,
  work: WorkEntry,
  edition: EditionEntry,
  version: Version = "edited",
): Promise<FullTextResponse> => ({
  author: author.meta,
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
  author: AuthorEntry,
  work: WorkEntry,
  edition: EditionEntry,
  path: string[],
  version: Version = "edited",
): Promise<SectionResponse | undefined> => {
  const section = findSkeleton(edition.sections, path);
  if (section === undefined) return undefined;

  const flat = flattenSkeleton(edition.sections);
  const index = flat.findIndex((s) =>
    s.path.join("/") === section.path.join("/")
  );
  const ancestors = section.path.slice(0, -1)
    .map((_slug, i) =>
      findSkeleton(edition.sections, section.path.slice(0, i + 1))
    )
    .filter((s): s is SkeletonSection => s !== undefined);

  const keys = pathKey(section.path);
  const compareEditions = work.editions
    .filter((other) => other !== edition)
    .flatMap((other) => {
      const match = findSectionByKey(other.sections, keys);
      return match === undefined
        ? []
        : [{ slug: other.meta.slug, path: match.path }];
    });

  const prev = flat[index - 1];
  const next = flat[index + 1];
  return {
    author: author.meta,
    work: work.meta,
    edition: edition.meta,
    version,
    section: {
      path: section.path,
      title: section.title,
      breadcrumb: section.breadcrumb,
      imported: section.imported,
      blocks: (await store.blocks(section.units))
        .map((block) => resolveBlock(block, version)),
      children: section.children.map(sectionSummary),
    },
    ancestors: ancestors.map(sectionRef),
    prev: prev === undefined ? undefined : sectionRef(prev),
    next: next === undefined ? undefined : sectionRef(next),
    compareEditions,
  };
};

export const sectionFullTextResponse = async (
  store: BlockStore,
  author: AuthorEntry,
  work: WorkEntry,
  edition: EditionEntry,
  path: string[],
  version: Version = "edited",
): Promise<SectionFullTextResponse | undefined> => {
  const skeleton = findSkeleton(edition.sections, path);
  if (skeleton === undefined) return undefined;

  const flat = flattenSkeleton(edition.sections);
  const index = flat.findIndex((s) =>
    s.path.join("/") === skeleton.path.join("/")
  );
  const ancestors = skeleton.path.slice(0, -1)
    .map((_slug, i) =>
      findSkeleton(edition.sections, skeleton.path.slice(0, i + 1))
    )
    .filter((s): s is SkeletonSection => s !== undefined);

  const keys = pathKey(skeleton.path);
  const compareEditions: EditionSection[] = work.editions
    .filter((other) => other !== edition)
    .flatMap((other) => {
      const match = findSectionByKey(other.sections, keys);
      return match === undefined
        ? []
        : [{ slug: other.meta.slug, path: match.path }];
    });

  return {
    author: author.meta,
    work: work.meta,
    edition: edition.meta,
    version,
    section: await sectionContent(store, skeleton, version),
    ancestors: ancestors.map(sectionRef),
    prev: flat[index - 1] === undefined
      ? undefined
      : sectionRef(flat[index - 1]),
    next: flat[index + 1] === undefined
      ? undefined
      : sectionRef(flat[index + 1]),
    compareEditions,
  };
};

export const compareResponse = (
  author: AuthorEntry,
  work: WorkEntry,
  aSlug: string,
  bSlug: string,
): CompareResponse | undefined => {
  const a = findEditionEntry(work, aSlug);
  const b = findEditionEntry(work, bSlug);
  if (a === undefined || b === undefined || a === b) return undefined;
  return {
    author: author.meta,
    work: work.meta,
    a: a.meta,
    b: b.meta,
    rows: alignSections(a.sections, b.sections).map(alignedRow),
  };
};

export const compareSectionResponse = async (
  store: BlockStore,
  author: AuthorEntry,
  work: WorkEntry,
  aSlug: string,
  bSlug: string,
  path: string[],
  version: Version = "edited",
): Promise<CompareSectionResponse | undefined> => {
  const a = findEditionEntry(work, aSlug);
  const b = findEditionEntry(work, bSlug);
  if (a === undefined || b === undefined || a === b) return undefined;
  const keys = pathKey(path);
  const sectionA = findSectionByKey(a.sections, keys);
  const sectionB = findSectionByKey(b.sections, keys);
  if (sectionA === undefined || sectionB === undefined) return undefined;
  const [blocksA, blocksB] = await Promise.all([
    store.blocks(sectionA.units),
    store.blocks(sectionB.units),
  ]);
  // Resolve each edition to the chosen version first, then diff: the markup
  // in the result expresses the A↔B difference, not either edition's own
  // corrections (which the resolution has already applied).
  const diffs = diffBlocks(
    blocksA.map((block) => resolveBlock(block, version)),
    blocksB.map((block) => resolveBlock(block, version)),
  );

  // Other editions of the work that also contain this section, for switching
  // either side of the comparison.
  const compareEditions = work.editions
    .filter((other) => other !== a && other !== b)
    .flatMap((other) => {
      const match = findSectionByKey(other.sections, keys);
      return match === undefined
        ? []
        : [{ slug: other.meta.slug, path: match.path }];
    });

  // Step through edition A's reading order to the nearest neighbour that also
  // exists in edition B, so the next/prev comparison can never 404.
  const flatA = flattenSkeleton(a.sections);
  const index = flatA.findIndex((s) =>
    s.path.join("/") === sectionA.path.join("/")
  );
  const neighbourInBoth = (step: number): SectionRef | undefined => {
    for (let i = index + step; i >= 0 && i < flatA.length; i += step) {
      const candidate = flatA[i];
      if (findSectionByKey(b.sections, pathKey(candidate.path)) !== undefined) {
        return sectionRef(candidate);
      }
    }
    return undefined;
  };

  return {
    author: author.meta,
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
const parseMatch = (match?: MatchLevel): MatchLevel =>
  match === "exact" ? "exact" : match === "spelling" ? "spelling" : "form";

const MAX_PER_PAGE = 100;

export const frequencyResponse = (
  artefacts: ServeArtefacts,
  params: FrequencyParams,
): FrequencyResponse => {
  const q = params.q.trim();
  const by: "author" | "work" | "edition" = params.by === "author"
    ? "author"
    : params.by === "edition"
    ? "edition"
    : "work";
  const options: SearchOptions = {
    match: parseMatch(params.match),
    caseSensitive: params.caseSensitive ?? false,
  };
  const version: Version = params.version === "original"
    ? "original"
    : "edited";
  const hits = q === "" ? [] : search(
    artefacts,
    q,
    { author: params.author, work: params.work, edition: params.edition },
    options,
    version,
  );

  // Each phrase match contributes phraseLength positions; dividing recovers
  // the occurrence count without re-running phrase matching.
  const phraseLength = Math.max(1, parseQuery(q).length);
  const { units, manifest, editionUnits } = artefacts;

  // Total token count per edition index (summed once, reused across groups).
  const editionTokenCounts = manifest.editions.map((_, i) =>
    editionUnits[i].reduce((s, u) => s + units.tokenCount[u], 0)
  );

  type GroupData = {
    count: number;
    tokens: number;
    label: string;
    author: string;
    work: string;
    edition: string | null;
  };
  const groups = new Map<string, GroupData>();

  const groupKey = (author: string, work: string, edition: string): string =>
    by === "author"
      ? author
      : by === "edition"
      ? `${author}/${work}/${edition}`
      : `${author}/${work}`;

  // First pass: count occurrences per group from hits.
  for (const hit of hits) {
    const ref = manifest.editions[units.edition[hit.unitIndex]];
    const key = groupKey(ref.author, ref.work, ref.edition);
    if (!groups.has(key)) {
      const label = by === "author"
        ? ref.authorName
        : by === "edition"
        ? `${ref.workBreadcrumb} (${ref.edition})`
        : ref.workBreadcrumb;
      groups.set(key, {
        count: 0,
        tokens: 0,
        label,
        author: ref.author,
        work: ref.work,
        edition: by === "edition" ? ref.edition : null,
      });
    }
    groups.get(key)!.count += Math.round(hit.positions.length / phraseLength);
  }

  // Second pass: sum in-scope token counts as the relative-frequency denominator.
  // Uses the same edition filter as search() so the scope is consistent.
  for (let i = 0; i < manifest.editions.length; i++) {
    const ref = manifest.editions[i];
    if (params.author !== undefined && ref.author !== params.author) continue;
    if (params.work !== undefined && ref.work !== params.work) continue;
    if (params.edition === undefined) {
      if (!ref.canonical) continue;
    } else if (params.edition !== "all" && ref.edition !== params.edition) {
      continue;
    }
    const key = groupKey(ref.author, ref.work, ref.edition);
    const group = groups.get(key);
    if (group !== undefined) group.tokens += editionTokenCounts[i];
  }

  const results: FrequencyEntry[] = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => ({
      label: g.label,
      author: g.author,
      work: g.work,
      edition: g.edition,
      count: g.count,
      tokens: g.tokens,
      relative: g.tokens > 0
        ? Math.round((g.count / g.tokens) * 10000) / 10
        : 0,
    }));

  return {
    q,
    by,
    total: results.reduce((s, r) => s + r.count, 0),
    results,
  };
};

/* ------------------------------ keywords ----------------------------- */

const MAX_KEYWORDS = 500;
const DEFAULT_KEYWORDS = 50;
const DEFAULT_MIN_COUNT = 5;

const parseMode = (by?: KeyMode): KeyMode =>
  by === "surface" ? "surface" : by === "form" ? "form" : "lemma";

const per1000 = (count: number, tokens: number): number =>
  tokens > 0 ? Math.round((count / tokens) * 10000) / 10 : 0;

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
  const version: "edited" | "original" = params.version === "original"
    ? "original"
    : "edited";
  const minCount = Math.max(1, Math.floor(params.min ?? DEFAULT_MIN_COUNT));
  const limit = Math.min(
    MAX_KEYWORDS,
    Math.max(1, Math.floor(params.limit ?? DEFAULT_KEYWORDS)),
  );
  const editionScope = params.edition;
  const empty: KeywordsResponse = {
    by: mode,
    version,
    author: params.author ?? null,
    work: params.work ?? null,
    edition: editionScope ?? null,
    targetTokens: 0,
    referenceTokens: 0,
    total: 0,
    results: [],
  };
  // No target, no keywords (a target is an author, optionally narrowed to a work).
  if (params.author === undefined) return empty;

  const { manifest, units } = artefacts;
  // Classify each edition once (target / reference / out), then label its units.
  const inUniverse = (canonical: boolean, edition: string): boolean =>
    editionScope === undefined
      ? canonical
      : editionScope === "all" || edition === editionScope;
  const editionClass = manifest.editions.map((ref) => {
    if (!inUniverse(ref.canonical, ref.edition)) return 0;
    const isTarget =
      (params.author === undefined || ref.author === params.author) &&
      (params.work === undefined || ref.work === params.work);
    return isTarget ? TARGET : REFERENCE;
  });
  const scope = new Int8Array(units.edition.length);
  for (let unit = 0; unit < scope.length; unit++) {
    scope[unit] = editionClass[units.edition[unit]];
  }

  const result = keyness(artefacts, scope, { mode, version, minCount, limit });
  return {
    by: mode,
    version,
    author: params.author ?? null,
    work: params.work ?? null,
    edition: editionScope ?? null,
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
  const window = Math.min(
    MAX_WINDOW,
    Math.max(1, Math.floor(params.window ?? DEFAULT_WINDOW)),
  );
  const minCount = Math.max(
    1,
    Math.floor(params.min ?? DEFAULT_COLLOCATION_MIN),
  );
  const limit = Math.min(
    MAX_COLLOCATIONS,
    Math.max(1, Math.floor(params.limit ?? DEFAULT_COLLOCATIONS)),
  );
  const editionScope = params.edition;
  const empty: CollocationsResponse = {
    q,
    by: mode,
    match,
    window,
    author: params.author ?? null,
    work: params.work ?? null,
    edition: editionScope ?? null,
    scopeTokens: 0,
    nodeCount: 0,
    windowTokens: 0,
    total: 0,
    results: [],
  };
  if (q === "") return empty;

  // The node word's surfaces, united across the query's words at the match level.
  const nodeSurfaces = new Set<number>();
  for (const word of parseQuery(q)) {
    for (const id of surfaceIds(artefacts, word.surface, match)) {
      nodeSurfaces.add(id);
    }
  }
  if (nodeSurfaces.size === 0) return empty;

  const { manifest, units, postings } = artefacts;
  // Classify each edition once (in scope / out), then label its units. The
  // universe mirrors search/keywords: canonical editions by default, or the
  // named edition slug ("all" for every printing).
  const inUniverse = (canonical: boolean, edition: string): boolean =>
    editionScope === undefined
      ? canonical
      : editionScope === "all" || edition === editionScope;
  const editionInScope = manifest.editions.map((ref) =>
    inUniverse(ref.canonical, ref.edition) &&
    (params.author === undefined || ref.author === params.author) &&
    (params.work === undefined || ref.work === params.work)
  );
  const scope = new Int8Array(units.edition.length);
  for (let unit = 0; unit < scope.length; unit++) {
    if (editionInScope[units.edition[unit]]) scope[unit] = IN_SCOPE;
  }

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
    edition: editionScope ?? null,
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
): SimilarLevel =>
  level === "section" || level === "edition" || level === "work"
    ? level
    : hasPath
    ? "section"
    : "edition";

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
  const limit = Math.min(
    MAX_SIMILAR,
    Math.max(1, Math.floor(params.limit ?? DEFAULT_SIMILAR)),
  );
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
  // Resolve the target edition: the named one, or the work's canonical edition
  // when omitted. The work level ignores any named edition and takes the
  // canonical printing, so the target is represented as the result universe is.
  const wantEdition = level === "work" ? undefined : params.edition;
  const targetEdition = manifest.editions.findIndex((ref) =>
    ref.author === params.author && ref.work === params.work &&
    (wantEdition === undefined ? ref.canonical : ref.edition === wantEdition)
  );
  if (targetEdition === -1) return notFound;
  const resolvedEdition = manifest.editions[targetEdition].edition;

  const dtm = await dtmStore.matrix();
  const targetKey = sectionPath.join("/");

  // The target's document rows: the matching section at the section level, or
  // every section of the target edition at the edition/work level.
  const targetDocs: number[] = [];
  for (let d = 0; d < dtm.docs.length; d++) {
    if (dtm.docs[d].edition !== targetEdition) continue;
    if (level === "section" && dtm.docs[d].sectionPath !== targetKey) continue;
    targetDocs.push(d);
  }
  // Found only if the target carries indexed text (a non-empty vector).
  const found = targetDocs.some((d) => dtm.rowPtr[d] < dtm.rowPtr[d + 1]);
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
    if (ref.author === params.author && ref.work === params.work) continue;
    const key = level === "work"
      ? `${ref.author}/${ref.work}`
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
        author: ref.author,
        authorName: ref.authorName,
        work: ref.work,
        workBreadcrumb: ref.workBreadcrumb,
        edition: level === "work" ? null : ref.edition,
        sectionPath: level === "section"
          ? (docPath === "" ? [] : docPath.split("/"))
          : [],
        sectionTitle: level === "section"
          ? titleOf.get(`${dtm.docs[d].edition}\t${docPath}`) ?? null
          : null,
        score: 0,
      });
    }
    groupDocs[g].push(d);
  }

  const ranked = similar(dtm, targetDocs, groupDocs, { limit });
  const results = ranked.map((row) => ({
    ...labels[row.group],
    score: row.score,
  }));
  return {
    level,
    author: params.author,
    work: params.work,
    edition: level === "work" ? null : resolvedEdition,
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
  const nTerms = Math.min(
    MAX_TOPIC_TERMS,
    Math.max(1, Math.floor(params.terms ?? DEFAULT_TOPIC_TERMS)),
  );
  const nWorks = Math.min(
    MAX_PROMINENT_WORKS,
    Math.max(1, Math.floor(params.works ?? DEFAULT_PROMINENT_WORKS)),
  );

  // Group the canonical-edition documents by work, then aggregate each work's
  // topic mix once (reused across all topics). `labels` runs parallel to the
  // groups.
  const groupDocs: number[][] = [];
  const labels: {
    author: string;
    authorName: string;
    work: string;
    workBreadcrumb: string;
    edition: string;
  }[] = [];
  const groupOf = new Map<string, number>();
  for (let d = 0; d < model.docs.length; d++) {
    const ref = manifest.editions[model.docs[d].edition];
    if (!ref.canonical) continue;
    const key = `${ref.author}/${ref.work}`;
    let g = groupOf.get(key);
    if (g === undefined) {
      g = groupDocs.length;
      groupOf.set(key, g);
      groupDocs.push([]);
      labels.push({
        author: ref.author,
        authorName: ref.authorName,
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
  const wantEdition = level === "work" ? undefined : params.edition;
  const targetEdition = manifest.editions.findIndex((ref) =>
    ref.author === params.author && ref.work === params.work &&
    (wantEdition === undefined ? ref.canonical : ref.edition === wantEdition)
  );
  if (targetEdition === -1) return notFound;
  const resolvedEdition = manifest.editions[targetEdition].edition;

  const model = await topicsStore.model();
  const targetKey = sectionPath.join("/");
  const targetDocs: number[] = [];
  for (let d = 0; d < model.docs.length; d++) {
    if (model.docs[d].edition !== targetEdition) continue;
    if (level === "section" && model.docs[d].sectionPath !== targetKey) {
      continue;
    }
    targetDocs.push(d);
  }

  const mix = aggregateMix(model, targetDocs);
  let sum = 0;
  for (let t = 0; t < model.k; t++) sum += mix[t];
  if (sum === 0) return notFound; // no indexed text → no mix

  const limit = Math.min(
    model.k,
    Math.max(1, Math.floor(params.limit ?? DEFAULT_MIX_TOPICS)),
  );
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
    edition: level === "work" ? null : resolvedEdition,
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
  };
  const version: Version = params.version === "original"
    ? "original"
    : "edited";
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, Math.floor(params.perPage ?? 20)),
  );
  const hits = q === "" ? [] : search(
    artefacts,
    q,
    {
      author: params.author,
      work: params.work,
      edition: params.edition,
    },
    options,
    version,
  );
  const pages = Math.max(1, Math.ceil(hits.length / perPage));
  const pageHits = hits.slice((page - 1) * perPage, page * perPage);
  const { units, manifest } = artefacts;
  return {
    q,
    match: options.match,
    caseSensitive: options.caseSensitive,
    version,
    total: hits.length,
    page,
    pages,
    results: await Promise.all(pageHits.map(async (hit) => {
      // Positions index into the version's tokenization; highlightBlock
      // resolves the block to that version and injects the marks in one walk.
      const block: Block = await store.unitBlock(hit.unitIndex);
      const ranges = matchRanges(blockText(block, version), hit.positions);
      const ref = manifest.editions[units.edition[hit.unitIndex]];
      const sectionPath = units.sectionPath[hit.unitIndex];
      return {
        author: ref.author,
        authorName: ref.authorName,
        work: ref.work,
        workBreadcrumb: ref.workBreadcrumb,
        edition: ref.edition,
        sectionPath: sectionPath === "" ? [] : sectionPath.split("/"),
        sectionTitle: units.sectionTitle[hit.unitIndex],
        blockId: units.blockId[hit.unitIndex],
        score: hit.score,
        block: highlightBlock(block, ranges, version),
      };
    })),
  };
};

/* ---------------------------- concordance ---------------------------- */

const DEFAULT_CONTEXT = 6;
const MAX_CONTEXT = 25;

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
  };
  const version: Version = params.version === "original"
    ? "original"
    : "edited";
  const sort: Sort = params.sort === "left"
    ? "left"
    : params.sort === "right"
    ? "right"
    : "position";
  const context = Math.min(
    MAX_CONTEXT,
    Math.max(1, Math.floor(params.context ?? DEFAULT_CONTEXT)),
  );
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, Math.floor(params.perPage ?? 20)),
  );
  const phraseLen = Math.max(1, parseQuery(q).length);
  const hits = q === "" ? [] : search(
    artefacts,
    q,
    { author: params.author, work: params.work, edition: params.edition },
    options,
    version,
  );

  const { units, manifest } = artefacts;
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
    const text = blockText(block, version);
    const spans = tokenize(text);
    const ref = manifest.editions[units.edition[hit.unitIndex]];
    const sectionPath = units.sectionPath[hit.unitIndex];
    for (const start of occurrences(hit.positions, phraseLen)) {
      const parts = lineParts(text, spans, start, phraseLen, context);
      built.push({
        author: ref.author,
        authorName: ref.authorName,
        work: ref.work,
        workBreadcrumb: ref.workBreadcrumb,
        edition: ref.edition,
        sectionPath: sectionPath === "" ? [] : sectionPath.split("/"),
        sectionTitle: units.sectionTitle[hit.unitIndex],
        blockId: units.blockId[hit.unitIndex],
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
  const pages = Math.max(1, Math.ceil(built.length / perPage));
  const lines = built.slice((page - 1) * perPage, page * perPage).map(
    ({ unitIndex: _u, start: _s, leftWords: _l, rightWords: _r, ...line }) =>
      line,
  );
  return {
    q,
    context,
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
