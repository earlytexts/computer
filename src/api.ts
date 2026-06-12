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
import { diffBlocks } from "./lib/diff.ts";
import { readUnitBlock } from "./lib/artefacts.ts";
import {
  matchRanges,
  parseQuery,
  search,
  type SearchMode,
} from "./lib/search.ts";
import { blockText, highlightBlock } from "./lib/text.ts";
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
): Promise<SectionContent> => ({
  slug: section.slug,
  path: section.path,
  title: section.title,
  breadcrumb: section.breadcrumb,
  imported: section.imported,
  blocks: await store.blocks(section.units),
  children: await Promise.all(
    section.children.map((child) => sectionContent(store, child)),
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
): Promise<EditionResponse> => ({
  author: author.meta,
  work: work.meta,
  edition: edition.meta,
  blocks: await store.blocks(edition.units),
  sections: edition.sections.map(sectionSummary),
});

export const fullTextResponse = async (
  store: BlockStore,
  author: AuthorEntry,
  work: WorkEntry,
  edition: EditionEntry,
): Promise<FullTextResponse> => ({
  author: author.meta,
  work: work.meta,
  edition: edition.meta,
  blocks: await store.blocks(edition.units),
  sections: await Promise.all(
    edition.sections.map((section) => sectionContent(store, section)),
  ),
});

export const sectionResponse = async (
  store: BlockStore,
  author: AuthorEntry,
  work: WorkEntry,
  edition: EditionEntry,
  path: string[],
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
    .filter((other) =>
      other !== edition &&
      findSectionByKey(other.sections, keys) !== undefined
    )
    .map((other) => other.meta.slug);

  const prev = flat[index - 1];
  const next = flat[index + 1];
  return {
    author: author.meta,
    work: work.meta,
    edition: edition.meta,
    section: {
      path: section.path,
      title: section.title,
      breadcrumb: section.breadcrumb,
      imported: section.imported,
      blocks: await store.blocks(section.units),
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
  return {
    author: author.meta,
    work: work.meta,
    a: a.meta,
    b: b.meta,
    title: sectionB.title,
    diffs: diffBlocks(blocksA, blocksB),
    childRows: alignSections(sectionA.children, sectionB.children)
      .map(alignedRow),
  };
};

/* ------------------------------- search ------------------------------ */

export type SearchParams = {
  q: string;
  mode?: string;
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
  const mode: SearchMode = params.mode === "exact" ? "exact" : "normalised";
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, Math.floor(params.perPage ?? 20)),
  );
  const hits = q === "" ? [] : search(artefacts, parseQuery(q), {
    author: params.author,
    work: params.work,
    edition: params.edition,
  }, mode);
  const pages = Math.max(1, Math.ceil(hits.length / perPage));
  const pageHits = hits.slice((page - 1) * perPage, page * perPage);
  const { units, manifest } = artefacts;
  return {
    q,
    mode,
    total: hits.length,
    page,
    pages,
    results: await Promise.all(pageHits.map(async (hit) => {
      const block: Block = await readUnitBlock(artefacts, hit.unitIndex);
      const ranges = matchRanges(blockText(block), hit.positions);
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
        block: highlightBlock(block, ranges),
      };
    })),
  };
};
