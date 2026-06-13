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
  type BlockStore,
  type CatalogArtefact,
  type EditionEntry,
  findEditionEntry,
  type ServeArtefacts,
  type SkeletonSection,
  type WorkEntry,
} from "./lib/artefacts.ts";
import {
  type AlignedSection,
  alignSections,
  findSectionByKey,
  pathKey,
} from "./lib/compare.ts";
import { diffBlocks, diffToBlocks } from "./lib/diff.ts";
import { readUnitBlock } from "./lib/artefacts.ts";
import { matchRanges, search, type SearchOptions } from "./lib/search.ts";
import { blockText, highlightBlock, resolveBlock } from "./lib/text.ts";
import type {
  AlignedRow,
  CatalogResponse,
  CompareResponse,
  CompareSectionResponse,
  EditionResponse,
  FullTextResponse,
  SearchResponse,
  SectionContent,
  SectionRef,
  SectionResponse,
  SectionSummary,
  Version,
} from "./types.ts";

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

export type SearchParams = {
  q: string;
  exactSpelling?: boolean;
  caseSensitive?: boolean;
  version?: string;
  author?: string;
  work?: string;
  edition?: string;
  page?: number;
  perPage?: number;
};

const MAX_PER_PAGE = 100;

export const searchResponse = async (
  artefacts: ServeArtefacts,
  params: SearchParams,
): Promise<SearchResponse> => {
  const q = params.q.trim();
  const options: SearchOptions = {
    exactSpelling: params.exactSpelling ?? false,
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
    exactSpelling: options.exactSpelling,
    caseSensitive: options.caseSensitive,
    version,
    total: hits.length,
    page,
    pages,
    results: await Promise.all(pageHits.map(async (hit) => {
      // Positions index into the version's tokenization; highlightBlock
      // resolves the block to that version and injects the marks in one walk.
      const block: Block = await readUnitBlock(artefacts, hit.unitIndex);
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
