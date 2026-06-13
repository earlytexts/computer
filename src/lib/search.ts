/**
 * Full-text search over the built artefacts (see artefacts.ts).
 *
 * The searchable unit is a single block (paragraph, footnote, or title), so
 * results link straight to the matching text. The inverted index is keyed
 * by SURFACE form (distinct case-folded spellings); a query is answered at
 * one of two layers:
 *
 *   - "normalised" (default): each query word is normalised and expanded to
 *     every surface form sharing that normalisation, so "show" finds "shew"
 *     and vice versa;
 *   - "exact": each query word matches its own surface form only, so
 *     "enquiry" and "inquiry" are distinct.
 *
 * Query syntax:
 *   - bare terms are ANDed:        liberty press
 *   - quoted phrases:              "abstruse philosophy"
 *   - trailing-star prefixes:      caus*
 * Results can additionally be filtered by author, work, and edition.
 *
 * Matched token positions are converted back to character ranges in a
 * block's extracted text by `matchRanges`, for highlighting via
 * highlightBlock (text.ts).
 */

import type { Postings, ServeArtefacts } from "./artefacts.ts";
import type { HighlightRange } from "./text.ts";
import type { Version } from "../types.ts";
import { normalizeSurface, surfaceForm, tokenize } from "./tokenize.ts";

export type SearchMode = "exact" | "normalised";

export type Query = {
  terms: string[]; // surface-folded single words
  prefixes: string[]; // surface-folded prefixes (from trailing *)
  phrases: string[][]; // surface-folded word sequences
};

export const parseQuery = (q: string): Query => {
  const query: Query = { terms: [], prefixes: [], phrases: [] };
  const phraseRe = /"([^"]*)"/g;
  let rest = "";
  let lastEnd = 0;
  for (const match of q.matchAll(phraseRe)) {
    rest += q.slice(lastEnd, match.index) + " ";
    lastEnd = match.index + match[0].length;
    const words = tokenize(match[1]).map((span) => span.surface);
    if (words.length > 0) query.phrases.push(words);
  }
  rest += q.slice(lastEnd);
  for (const word of rest.split(/\s+/)) {
    if (word === "") continue;
    if (word.endsWith("*") && word.length > 1) {
      const prefix = surfaceForm(word.slice(0, -1));
      if (prefix !== "") query.prefixes.push(prefix);
    } else {
      query.terms.push(...tokenize(word).map((span) => span.surface));
    }
  }
  return query;
};

/* --------------------------- query expansion -------------------------- */

/** Index of `value` in a sorted array, or undefined. */
const lookupId = (sorted: string[], value: string): number | undefined => {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else if (sorted[mid] > value) hi = mid - 1;
    else return mid;
  }
  return undefined;
};

/** Indices of every entry in a sorted array starting with `prefix`. */
const prefixIds = (sorted: string[], prefix: string): number[] => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const ids: number[] = [];
  for (let i = lo; i < sorted.length; i++) {
    if (!sorted[i].startsWith(prefix)) break;
    ids.push(i);
  }
  return ids;
};

/** Surface ids matching one query word at the given layer. */
const wordIds = (
  artefacts: ServeArtefacts,
  word: string,
  mode: SearchMode,
): number[] => {
  if (mode === "exact") {
    const id = lookupId(artefacts.vocab.surfaces, word);
    return id === undefined ? [] : [id];
  }
  const normId = lookupId(artefacts.vocab.norms, normalizeSurface(word));
  return normId === undefined ? [] : artefacts.normSurfaces[normId];
};

/**
 * Surface ids matching a prefix. At the normalised layer the prefix is
 * matched against both normalised and surface forms (united), so "she*"
 * finds shew-spellings whichever way the reader thinks of them.
 */
const prefixSurfaceIds = (
  artefacts: ServeArtefacts,
  prefix: string,
  mode: SearchMode,
): number[] => {
  const direct = prefixIds(artefacts.vocab.surfaces, prefix);
  if (mode === "exact") return direct;
  const viaNorms = prefixIds(artefacts.vocab.norms, prefix)
    .flatMap((normId) => artefacts.normSurfaces[normId]);
  return [...new Set([...direct, ...viaNorms])];
};

/* ------------------------------ matching ------------------------------ */

/** Map of unitIndex -> matched token positions, or null for "nothing". */
type Candidates = Map<number, number[]> | null;

/** Add the (unit, position) pairs for the given surface ids to `out`,
 * skipping any unit in `skip`. */
const collectPostings = (
  postings: Postings,
  ids: number[],
  out: Map<number, number[]>,
  skip?: Set<number>,
): void => {
  const { offsets, pairs } = postings;
  for (const id of ids) {
    for (let i = offsets[id] * 2; i < offsets[id + 1] * 2; i += 2) {
      const unit = pairs[i];
      if (skip !== undefined && skip.has(unit)) continue;
      const positions = out.get(unit);
      if (positions === undefined) out.set(unit, [pairs[i + 1]]);
      else positions.push(pairs[i + 1]);
    }
  }
};

/**
 * Postings for the given surface ids in the requested version. The primary
 * index is the edited reading text; for `original` the units that carry
 * editorial markup come from the overlay instead (with original-version
 * positions), so phrase matching stays consistent within every unit.
 */
const postingsFor = (
  artefacts: ServeArtefacts,
  ids: number[],
  version: Version,
): Map<number, number[]> => {
  const out = new Map<number, number[]>();
  if (version === "original") {
    collectPostings(artefacts.postings, ids, out, artefacts.affectedUnits);
    collectPostings(artefacts.overlayPostings, ids, out);
  } else {
    collectPostings(artefacts.postings, ids, out);
  }
  return out;
};

const intersect = (a: Candidates, b: Candidates): Candidates => {
  if (a === null || b === null) return null;
  const out = new Map<number, number[]>();
  for (const [unit, positions] of a) {
    const other = b.get(unit);
    if (other !== undefined) out.set(unit, [...positions, ...other]);
  }
  return out;
};

const phraseCandidates = (
  artefacts: ServeArtefacts,
  phrase: string[],
  mode: SearchMode,
  version: Version,
): Map<number, number[]> => {
  const slots = phrase.map((word) =>
    postingsFor(artefacts, wordIds(artefacts, word, mode), version)
  );
  if (slots.length === 1) return slots[0];
  const out = new Map<number, number[]>();
  for (const [unit, positions] of slots[0]) {
    const matched: number[] = [];
    for (const start of positions) {
      const ok = slots.slice(1).every((slot, i) =>
        slot.get(unit)?.includes(start + i + 1) ?? false
      );
      if (ok) {
        for (let i = 0; i < phrase.length; i++) matched.push(start + i);
      }
    }
    if (matched.length > 0) out.set(unit, matched);
  }
  return out;
};

export type SearchHit = {
  unitIndex: number;
  score: number;
  /** Ordinal positions (within the unit) of matched tokens, sorted. */
  positions: number[];
};

export type Filters = { author?: string; work?: string; edition?: string };

export const search = (
  artefacts: ServeArtefacts,
  query: Query,
  filters: Filters = {},
  mode: SearchMode = "normalised",
  version: Version = "edited",
): SearchHit[] => {
  const parts: Candidates[] = [
    ...query.terms.map((term) =>
      postingsFor(artefacts, wordIds(artefacts, term, mode), version)
    ),
    ...query.prefixes.map((prefix) =>
      postingsFor(artefacts, prefixSurfaceIds(artefacts, prefix, mode), version)
    ),
    ...query.phrases.map((phrase) =>
      phrase.length === 0
        ? null
        : phraseCandidates(artefacts, phrase, mode, version)
    ),
  ];
  if (parts.length === 0) return [];
  let candidates = parts[0];
  for (let i = 1; i < parts.length; i++) {
    candidates = intersect(candidates, parts[i]);
  }
  if (candidates === null) return [];

  const { units, manifest } = artefacts;
  const hits: SearchHit[] = [];
  for (const [unitIndex, positions] of candidates) {
    if (positions.length === 0) continue;
    const ref = manifest.editions[units.edition[unitIndex]];
    if (filters.author !== undefined && ref.author !== filters.author) {
      continue;
    }
    if (filters.work !== undefined && ref.work !== filters.work) continue;
    if (filters.edition !== undefined && ref.edition !== filters.edition) {
      continue;
    }
    const weight = units.isTitle[unitIndex] === 1 ? 3 : 1;
    hits.push({
      unitIndex,
      positions: [...new Set(positions)].sort((a, b) => a - b),
      score: positions.length * weight,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.unitIndex - b.unitIndex);
  return hits;
};

/**
 * Character ranges of the matched tokens in a block's extracted text, for
 * highlightBlock. Runs of consecutive matched tokens (phrases) become one
 * range, so the words between them are marked too.
 */
export const matchRanges = (
  text: string,
  positions: number[],
): HighlightRange[] => {
  const spans = tokenize(text);
  const ranges: HighlightRange[] = [];
  for (const position of positions) {
    const span = spans[position];
    if (span === undefined) continue;
    const last = ranges[ranges.length - 1];
    if (last !== undefined && spans[position - 1]?.end === last.end) {
      last.end = span.end;
    } else ranges.push({ start: span.start, end: span.end });
  }
  return ranges;
};
