/**
 * Full-text search over every edition of every work.
 *
 * An inverted index is built in memory at startup. The searchable unit is
 * a single block (paragraph, footnote, or title) of a section, so results
 * link straight to the matching paragraph. Tokens are normalised (case,
 * accents, ligatures, apostrophes) and passed through the variant-spelling
 * table in variants.json, so old and modern spellings match each other.
 *
 * Query syntax:
 *   - bare terms are ANDed:        liberty press
 *   - quoted phrases:              "abstruse philosophy"
 *   - trailing-star prefixes:      caus*
 * Results can additionally be filtered by author, work, and edition.
 */

import type { Block, MarkitDocument } from "@earlytexts/markit";
import type { SnippetPart } from "../types.ts";
import type { Catalog, Edition, Work } from "./catalog.ts";
import { childSlug, lastSegment } from "./catalog.ts";
import { blockText } from "./text.ts";
import variantsJson from "./variants.json" with { type: "json" };

export type { SnippetPart };

const VARIANTS = new Map<string, string>(
  Object.entries(variantsJson).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && !entry[0].startsWith("__"),
  ),
);

export const normalizeToken = (raw: string): string => {
  const base = raw
    .toLowerCase()
    .replace(/['’]/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/^-+|-+$/g, "");
  return VARIANTS.get(base) ?? base;
};

const WORD_RE = /[\p{L}\p{N}'’æœ-]+/giu;

export type TokenSpan = { token: string; start: number; end: number };

export const tokenizeText = (text: string): TokenSpan[] => {
  const spans: TokenSpan[] = [];
  for (const match of text.matchAll(WORD_RE)) {
    const token = normalizeToken(match[0]);
    if (token !== "") {
      spans.push({
        token,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return spans;
};

export type SearchUnit = {
  author: string;
  work: string;
  edition: string;
  sectionPath: string[];
  sectionTitle: string;
  blockId: string;
  isTitle: boolean;
  text: string;
};

export type SearchIndex = {
  units: SearchUnit[];
  /** token -> flat postings [unitIndex, position, unitIndex, position, ...] */
  postings: Map<string, number[]>;
  /** all tokens, sorted, for prefix expansion */
  tokens: string[];
  /** distinct edition slugs across the catalog, for the filter UI */
  editionSlugs: string[];
};

export const buildIndex = (catalog: Catalog): SearchIndex => {
  const units: SearchUnit[] = [];
  const postings = new Map<string, number[]>();

  const indexUnit = (
    work: Work,
    edition: Edition,
    sectionPath: string[],
    sectionTitle: string,
    block: Block,
  ) => {
    const text = blockText(block).trim();
    if (text === "") return;
    const unitIndex = units.length;
    units.push({
      author: work.authorSlug,
      work: work.slug,
      edition: edition.slug,
      sectionPath,
      sectionTitle,
      blockId: lastSegment(block.id),
      isTitle: block.type === "title" || block.type === "subtitle",
      text,
    });
    const spans = tokenizeText(text);
    for (let position = 0; position < spans.length; position++) {
      const token = spans[position].token;
      let list = postings.get(token);
      if (list === undefined) {
        list = [];
        postings.set(token, list);
      }
      list.push(unitIndex, position);
    }
  };

  const ownsDocument = (work: Work, doc: MarkitDocument): boolean => {
    const source = catalog.sources.get(doc);
    return source === undefined || source.startsWith(work.dir + "/") ||
      source === work.dir;
  };

  const indexSections = (
    work: Work,
    edition: Edition,
    doc: MarkitDocument,
    path: string[],
  ) => {
    for (const child of doc.children) {
      // Skip children whose text belongs to another work (composite
      // editions like ETSS share documents with EMPL/EHU/etc.); they are
      // indexed under their own work instead.
      if (!ownsDocument(work, child)) continue;
      const childPath = [...path, childSlug(child, doc)];
      const title = typeof child.metadata?.title === "string"
        ? child.metadata.title
        : lastSegment(child.id);
      for (const block of child.blocks) {
        indexUnit(work, edition, childPath, title, block);
      }
      indexSections(work, edition, child, childPath);
    }
  };

  for (const author of catalog.authors) {
    for (const work of author.works) {
      for (const edition of work.editions) {
        if (!ownsDocument(work, edition.document)) continue;
        for (const block of edition.document.blocks) {
          indexUnit(work, edition, [], edition.title, block);
        }
        indexSections(work, edition, edition.document, []);
      }
    }
  }

  const editionSlugs = [
    ...new Set(
      catalog.authors.flatMap((author) =>
        author.works.flatMap((w) => w.editions.map((e) => e.slug))
      ),
    ),
  ].sort();

  return {
    units,
    postings,
    tokens: [...postings.keys()].sort(),
    editionSlugs,
  };
};

export type Query = {
  terms: string[]; // normalised single tokens
  prefixes: string[]; // normalised prefixes (from trailing *)
  phrases: string[][]; // normalised token sequences
};

export const parseQuery = (q: string): Query => {
  const query: Query = { terms: [], prefixes: [], phrases: [] };
  const phraseRe = /"([^"]*)"/g;
  let rest = "";
  let lastEnd = 0;
  for (const match of q.matchAll(phraseRe)) {
    rest += q.slice(lastEnd, match.index) + " ";
    lastEnd = match.index + match[0].length;
    const tokens = tokenizeText(match[1]).map((s) => s.token);
    if (tokens.length > 0) query.phrases.push(tokens);
  }
  rest += q.slice(lastEnd);
  for (const word of rest.split(/\s+/)) {
    if (word === "") continue;
    if (word.endsWith("*") && word.length > 1) {
      const prefix = normalizeToken(word.slice(0, -1));
      if (prefix !== "") query.prefixes.push(prefix);
    } else {
      const tokens = tokenizeText(word).map((s) => s.token);
      query.terms.push(...tokens);
    }
  }
  return query;
};

export type SearchHit = {
  unit: SearchUnit;
  score: number;
  /** Ordinal positions (within the unit) of matched tokens. */
  positions: number[];
};

export type Filters = { author?: string; work?: string; edition?: string };

/** Map of unitIndex -> matched positions, or null for "matches nothing". */
type Candidates = Map<number, number[]> | null;

const intersect = (a: Candidates, b: Candidates): Candidates => {
  if (a === null || b === null) return null;
  const out = new Map<number, number[]>();
  for (const [unit, positions] of a) {
    const other = b.get(unit);
    if (other !== undefined) out.set(unit, [...positions, ...other]);
  }
  return out;
};

const postingsFor = (
  index: SearchIndex,
  tokens: string[],
): Map<number, number[]> => {
  const out = new Map<number, number[]>();
  for (const token of tokens) {
    const list = index.postings.get(token);
    if (list === undefined) continue;
    for (let i = 0; i < list.length; i += 2) {
      const unit = list[i];
      const positions = out.get(unit);
      if (positions === undefined) out.set(unit, [list[i + 1]]);
      else positions.push(list[i + 1]);
    }
  }
  return out;
};

const prefixTokens = (index: SearchIndex, prefix: string): string[] => {
  // Binary search the sorted token list for the prefix range.
  let lo = 0;
  let hi = index.tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.tokens[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const matches: string[] = [];
  for (let i = lo; i < index.tokens.length; i++) {
    if (!index.tokens[i].startsWith(prefix)) break;
    matches.push(index.tokens[i]);
  }
  return matches;
};

const phraseCandidates = (
  index: SearchIndex,
  phrase: string[],
): Map<number, number[]> => {
  const first = postingsFor(index, [phrase[0]]);
  if (phrase.length === 1) return first;
  const rest = phrase.slice(1).map((token) => postingsFor(index, [token]));
  const out = new Map<number, number[]>();
  for (const [unit, positions] of first) {
    const matched: number[] = [];
    for (const start of positions) {
      const ok = rest.every((tokenPositions, i) =>
        tokenPositions.get(unit)?.includes(start + i + 1) ?? false
      );
      if (ok) {
        for (let i = 0; i < phrase.length; i++) matched.push(start + i);
      }
    }
    if (matched.length > 0) out.set(unit, matched);
  }
  return out;
};

export const search = (
  index: SearchIndex,
  query: Query,
  filters: Filters = {},
): SearchHit[] => {
  const parts: Candidates[] = [
    ...query.terms.map((term) => postingsFor(index, [term])),
    ...query.prefixes.map((prefix) =>
      postingsFor(index, prefixTokens(index, prefix))
    ),
    ...query.phrases.map((phrase) =>
      phrase.length === 0 ? null : phraseCandidates(index, phrase)
    ),
  ];
  if (parts.length === 0) return [];
  let candidates = parts[0];
  for (let i = 1; i < parts.length; i++) {
    candidates = intersect(candidates, parts[i]);
  }
  // An empty map from a term with no postings also means no results.
  if (candidates === null) return [];

  const hits: SearchHit[] = [];
  for (const [unitIndex, positions] of candidates) {
    if (positions.length === 0) continue;
    const unit = index.units[unitIndex];
    if (
      filters.author !== undefined && unit.author !== filters.author
    ) continue;
    if (filters.work !== undefined && unit.work !== filters.work) continue;
    if (
      filters.edition !== undefined && unit.edition !== filters.edition
    ) continue;
    const weight = unit.isTitle ? 3 : 1;
    hits.push({
      unit,
      positions: [...new Set(positions)].sort((a, b) => a - b),
      score: positions.length * weight,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
};

/** Build a highlighted snippet around the first matched position. */
export const makeSnippet = (
  hit: SearchHit,
  contextTokens = 18,
): SnippetPart[] => {
  const spans = tokenizeText(hit.unit.text);
  if (spans.length === 0) return [{ text: hit.unit.text, marked: false }];
  const matched = new Set(hit.positions);
  const first = hit.positions[0] ?? 0;
  const from = Math.max(0, first - Math.floor(contextTokens / 2));
  const to = Math.min(spans.length - 1, from + contextTokens * 2);

  const parts: SnippetPart[] = [];
  const pushText = (text: string, marked: boolean) => {
    if (text === "") return;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.marked === marked) last.text += text;
    else parts.push({ text, marked });
  };

  if (from > 0) pushText("… ", false);
  for (let i = from; i <= to; i++) {
    if (i > from) {
      pushText(hit.unit.text.slice(spans[i - 1].end, spans[i].start), false);
    }
    pushText(
      hit.unit.text.slice(spans[i].start, spans[i].end),
      matched.has(i),
    );
  }
  if (to < spans.length - 1) pushText(" …", false);
  return parts;
};
