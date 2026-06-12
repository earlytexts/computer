/**
 * Pure builders for every API response: each takes the loaded catalog (and,
 * for search, the index) plus request parameters, and returns a serializable
 * value from types.ts, or undefined for "not found". The HTTP server is a
 * thin shell around these.
 */

import {
  type Catalog,
  type Edition,
  findEdition,
  findSection,
  flattenSections,
  type Section,
  sectionTree,
  type Work,
} from "./lib/catalog.ts";
import {
  type AlignedSection,
  alignSections,
  findSectionByKey,
  pathKey,
} from "./lib/compare.ts";
import { diffBlocks } from "./lib/diff.ts";
import {
  makeSnippet,
  parseQuery,
  search,
  type SearchIndex,
} from "./lib/search.ts";
import type {
  AlignedRow,
  CatalogResponse,
  CompareResponse,
  CompareSectionResponse,
  EditionMeta,
  EditionResponse,
  FullTextResponse,
  SearchResponse,
  SectionContent,
  SectionRef,
  SectionResponse,
  SectionSummary,
  WorkMeta,
} from "./types.ts";

const editionMeta = (edition: Edition): EditionMeta => ({
  workSlug: edition.workSlug,
  slug: edition.slug,
  isMain: edition.isMain,
  title: edition.title,
  breadcrumb: edition.breadcrumb,
  published: edition.published,
  copytext: edition.copytext,
  sourceDesc: edition.sourceDesc,
});

const workMeta = (work: Work): WorkMeta => ({
  slug: work.slug,
  title: work.title,
  breadcrumb: work.breadcrumb,
  editions: work.editions.map(editionMeta),
});

const sectionSummary = (section: Section): SectionSummary => ({
  slug: section.slug,
  path: section.path,
  title: section.title,
  breadcrumb: section.breadcrumb,
  children: section.children.map(sectionSummary),
});

const sectionContent = (section: Section): SectionContent => ({
  slug: section.slug,
  path: section.path,
  title: section.title,
  breadcrumb: section.breadcrumb,
  blocks: section.doc.blocks,
  children: section.children.map(sectionContent),
});

const sectionRef = (section: Section): SectionRef => ({
  path: section.path,
  breadcrumb: section.breadcrumb,
});

const alignedRow = (row: AlignedSection): AlignedRow => ({
  key: row.key,
  title: row.title,
  pathA: row.a?.path,
  pathB: row.b?.path,
  children: row.children.map(alignedRow),
});

export const catalogResponse = (catalog: Catalog): CatalogResponse => ({
  works: catalog.works.map(workMeta),
  editionSlugs: [
    ...new Set(catalog.works.flatMap((w) => w.editions.map((e) => e.slug))),
  ].sort(),
});

export const editionResponse = (
  work: Work,
  edition: Edition,
): EditionResponse => ({
  work: workMeta(work),
  edition: editionMeta(edition),
  blocks: edition.document.blocks,
  sections: sectionTree(edition.document).map(sectionSummary),
});

export const fullTextResponse = (
  work: Work,
  edition: Edition,
): FullTextResponse => ({
  work: workMeta(work),
  edition: editionMeta(edition),
  blocks: edition.document.blocks,
  sections: sectionTree(edition.document).map(sectionContent),
});

export const sectionResponse = (
  work: Work,
  edition: Edition,
  path: string[],
): SectionResponse | undefined => {
  const section = findSection(edition.document, path);
  if (section === undefined) return undefined;

  const flat = flattenSections(sectionTree(edition.document));
  const index = flat.findIndex((s) =>
    s.path.join("/") === section.path.join("/")
  );
  const ancestors = section.path.slice(0, -1)
    .map((_slug, i) =>
      findSection(edition.document, section.path.slice(0, i + 1))
    )
    .filter((s): s is Section => s !== undefined);

  const keys = pathKey(section.path);
  const compareEditions = work.editions
    .filter((other) =>
      other !== edition &&
      findSectionByKey(sectionTree(other.document), keys) !== undefined
    )
    .map((other) => other.slug);

  const prev = flat[index - 1];
  const next = flat[index + 1];
  return {
    work: workMeta(work),
    edition: editionMeta(edition),
    section: {
      path: section.path,
      title: section.title,
      breadcrumb: section.breadcrumb,
      blocks: section.doc.blocks,
      children: section.children.map(sectionSummary),
    },
    ancestors: ancestors.map(sectionRef),
    prev: prev === undefined ? undefined : sectionRef(prev),
    next: next === undefined ? undefined : sectionRef(next),
    compareEditions,
  };
};

export const compareResponse = (
  work: Work,
  aSlug: string,
  bSlug: string,
): CompareResponse | undefined => {
  const a = findEdition(work, aSlug);
  const b = findEdition(work, bSlug);
  if (a === undefined || b === undefined || a === b) return undefined;
  return {
    work: workMeta(work),
    a: editionMeta(a),
    b: editionMeta(b),
    rows: alignSections(sectionTree(a.document), sectionTree(b.document))
      .map(alignedRow),
  };
};

export const compareSectionResponse = (
  work: Work,
  aSlug: string,
  bSlug: string,
  path: string[],
): CompareSectionResponse | undefined => {
  const a = findEdition(work, aSlug);
  const b = findEdition(work, bSlug);
  if (a === undefined || b === undefined || a === b) return undefined;
  const keys = pathKey(path);
  const sectionA = findSectionByKey(sectionTree(a.document), keys);
  const sectionB = findSectionByKey(sectionTree(b.document), keys);
  if (sectionA === undefined || sectionB === undefined) return undefined;
  return {
    work: workMeta(work),
    a: editionMeta(a),
    b: editionMeta(b),
    title: sectionB.title,
    diffs: diffBlocks(sectionA.doc.blocks, sectionB.doc.blocks),
    childRows: alignSections(sectionA.children, sectionB.children)
      .map(alignedRow),
  };
};

export type SearchParams = {
  q: string;
  work?: string;
  edition?: string;
  page?: number;
  perPage?: number;
};

const MAX_PER_PAGE = 100;

export const searchResponse = (
  catalog: Catalog,
  index: SearchIndex,
  params: SearchParams,
): SearchResponse => {
  const q = params.q.trim();
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.min(
    MAX_PER_PAGE,
    Math.max(1, Math.floor(params.perPage ?? 20)),
  );
  const hits = q === "" ? [] : search(index, parseQuery(q), {
    work: params.work,
    edition: params.edition,
  });
  const pages = Math.max(1, Math.ceil(hits.length / perPage));
  const pageHits = hits.slice((page - 1) * perPage, page * perPage);
  return {
    q,
    total: hits.length,
    page,
    pages,
    results: pageHits.map((hit) => ({
      work: hit.unit.work,
      workBreadcrumb: catalog.bySlug.get(hit.unit.work)?.breadcrumb ??
        hit.unit.work,
      edition: hit.unit.edition,
      sectionPath: hit.unit.sectionPath,
      sectionTitle: hit.unit.sectionTitle,
      blockId: hit.unit.blockId,
      score: hit.score,
      snippet: makeSnippet(hit),
    })),
  };
};
