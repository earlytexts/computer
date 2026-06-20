/**
 * Hand-built API-response fixtures, shaped by the computer's contract types,
 * so the tests exercise rendering and tool dispatch without a running
 * computer or the real corpus.
 */

import { endLine, startLine } from "@earlytexts/markit";
import type { Block, InlineElement } from "@earlytexts/markit";
import type { Computer } from "../src/client.ts";
import type {
  CatalogResponse,
  ConcordanceResponse,
  EditionMeta,
  FrequencyResponse,
  SearchResponse,
  SectionResponse,
  WorkMeta,
} from "../src/types.ts";

export const plain = (content: string): InlineElement => ({
  type: "plainText",
  content,
});

export const highlighted = (content: string): InlineElement => ({
  type: "highlight",
  content: [plain(content)],
});

export const paragraph = (id: string, content: InlineElement[]): Block => ({
  id,
  type: "paragraph",
  content: [{ type: "paragraph", content }],
  [startLine]: 0,
  [endLine]: 0,
});

const edition = (
  slug: string,
  overrides?: Partial<EditionMeta>,
): EditionMeta => ({
  authorSlug: "hume",
  workSlug: "epm",
  slug,
  title: "An Enquiry concerning the Principles of Morals",
  breadcrumb: "EPM",
  imported: true,
  published: [Number(slug)],
  copytext: [],
  ...overrides,
});

const work: WorkMeta = {
  authorSlug: "hume",
  slug: "epm",
  title: "An Enquiry concerning the Principles of Morals",
  breadcrumb: "EPM",
  imported: true,
  published: [1751],
  canonicalSlug: "1772",
  editions: [edition("1751"), edition("1772")],
};

export const catalog: CatalogResponse = {
  authors: [{
    slug: "hume",
    forename: "David",
    surname: "Hume",
    birth: 1711,
    death: 1776,
    published: 1739,
    nationality: "Scottish",
    sex: "male",
    works: [work],
  }],
  editionSlugs: ["1751", "1772"],
};

export const search: SearchResponse = {
  q: "flames",
  match: "exact",
  caseSensitive: false,
  version: "edited",
  total: 1,
  page: 1,
  pages: 1,
  results: [{
    author: "hume",
    authorName: "Hume",
    work: "ehu",
    workBreadcrumb: "EHU",
    edition: "1772",
    sectionPath: ["12", "3"],
    sectionTitle: "Part 3",
    blockId: "p34",
    score: 1,
    block: paragraph("p34", [
      plain("Commit it then to the "),
      highlighted("flames"),
      plain(": for it can contain nothing but sophistry and illusion."),
    ]),
  }],
};

export const section: SectionResponse = {
  author: catalog.authors[0],
  work,
  edition: edition("1772"),
  version: "edited",
  section: {
    path: ["1"],
    title: "Section 1",
    breadcrumb: "EPM 1",
    imported: true,
    blocks: [
      paragraph("p1", [plain("Disputes with men, pertinaciously obstinate.")]),
    ],
    children: [],
  },
  ancestors: [],
  next: { path: ["2"], breadcrumb: "EPM 2" },
  compareEditions: [{ slug: "1751", path: ["1"] }],
};

export const frequency: FrequencyResponse = {
  q: "human nature",
  by: "work",
  total: 3,
  results: [
    {
      label: "An Enquiry concerning the Principles of Morals",
      author: "hume",
      work: "epm",
      edition: null,
      count: 2,
      tokens: 40000,
      relative: 0.1,
    },
    {
      label: "A Treatise of Human Nature",
      author: "hume",
      work: "thn",
      edition: null,
      count: 1,
      tokens: 250000,
      relative: 0,
    },
  ],
};

export const concordance: ConcordanceResponse = {
  q: "human nature",
  context: 5,
  sort: "position",
  match: "form",
  caseSensitive: false,
  version: "edited",
  total: 0,
  page: 1,
  pages: 1,
  lines: [],
};

/** A Computer whose every method is stubbed; override what the test needs. */
export const fakeComputer = (overrides: Partial<Computer>): Computer => ({
  catalog: () => Promise.resolve(catalog),
  edition: () => Promise.resolve(undefined),
  fullText: () => Promise.resolve(undefined),
  section: () => Promise.resolve(undefined),
  sectionFullText: () => Promise.resolve(undefined),
  compare: () => Promise.resolve(undefined),
  compareSection: () => Promise.resolve(undefined),
  search: () => Promise.resolve(search),
  frequency: () => Promise.resolve(frequency),
  concordance: () => Promise.resolve(concordance),
  ...overrides,
});
