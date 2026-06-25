/**
 * Full-text search over the built artefacts (see artefacts.ts).
 *
 * The searchable unit is a single block (paragraph, footnote, or title), so
 * results link straight to the matching text. The whole query is matched as
 * one phrase — its words must appear consecutively, in order — without the
 * reader having to quote it (boolean and prefix queries are deliberately left
 * for later). Two independent options control matching:
 *
 *   - match: which type level each query word is expanded over (see the
 *     pipeline in tokenize.ts). `exact` matches the surface as written
 *     ("enquiry" vs "inquiry", "causes" vs "cause" stay distinct); `spelling`
 *     unites old and modern spellings of the same form ("encrease"/"increase",
 *     but "increase" still distinct from "increases"); `form` (the default)
 *     additionally unites inflections ("connection between cause" matches
 *     "connexion betwixt causes").
 *   - caseSensitive: off (default) ignores case; on requires each word's
 *     initial capitalisation to agree with the text (so "Hume" skips lowercase
 *     "hume"). Resolved from a capitalisation bit on every posting (CAP_BIT),
 *     so it stays a pure in-memory filter — no per-hit text reads.
 *
 * The index is keyed by SURFACE form (distinct case-folded spellings); a query
 * word is expanded to every surface sharing its bucket at the chosen level (or
 * to its own surface only, for `exact`). Results can be filtered by author,
 * work, and edition.
 *
 * Hits are ranked by BM25 (the `score` field, deliberately opaque — only the
 * ordering it imposes is part of the contract). The whole query is one phrase,
 * so it acts as a single term: its document frequency is the number of units it
 * occurs in, and its term frequency in a unit is the count of phrase
 * occurrences there. BM25 saturates that term frequency (a fifth occurrence
 * adds far less than the first) and normalises by the unit's length against the
 * corpus average (the per-unit token counts in units.json), so a short block
 * full of the phrase outranks a long one that merely contains it. The phrase's
 * IDF is constant across all of one query's hits, so it never changes their
 * order; it is folded in only to keep the score a well-formed BM25 value. Title
 * blocks keep a fixed weight multiplier, as before.
 *
 * Matched token positions are converted back to character ranges in a block's
 * extracted text by `matchRanges`, for highlighting via highlightBlock
 * (text.ts).
 */

import {
  CAP_BIT,
  POSITION_MASK,
  type Postings,
  type ServeArtefacts,
} from "../artefacts.ts";
import type { HighlightRange } from "./text.ts";
import type { MatchLevel, Version } from "../../types.ts";
import { formKey, normalizeSpelling, tokenize } from "./tokenize.ts";

export type { MatchLevel };

export type SearchOptions = {
  /** Which type level each query word is expanded over. */
  match: MatchLevel;
  /** Require each query word's initial capitalisation to agree with the text. */
  caseSensitive: boolean;
};

export const DEFAULT_OPTIONS: SearchOptions = {
  match: "form",
  caseSensitive: false,
};

/** One word of the phrase: its case-folded surface and whether it was typed
 * with a leading capital (consulted only when caseSensitive). */
export type QueryWord = { surface: string; capital: boolean };

/** Split a query into its words, in order; the whole sequence is the phrase. */
export const parseQuery = (q: string): QueryWord[] =>
  tokenize(q).map((span) => ({
    surface: span.surface,
    capital: isCapital(q[span.start]),
  }));

const isCapital = (first: string): boolean =>
  first !== first.toLowerCase() && first === first.toUpperCase();

/* --------------------------- vocabulary lookup ------------------------ */

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

/** Surface ids matching one query word at the chosen level: the word's own
 * surface (`exact`), or every surface sharing its canonical spelling
 * (`spelling`) or its form bucket (`form`). The query word is folded the same
 * way the corresponding vocabulary level was built. */
export const surfaceIds = (
  artefacts: ServeArtefacts,
  surface: string,
  match: MatchLevel,
): number[] => {
  const { vocab, spellingSurfaces, formSurfaces } = artefacts;
  if (match === "exact") {
    const id = lookupId(vocab.surfaces, surface);
    return id === undefined ? [] : [id];
  }
  const spelling = normalizeSpelling(surface);
  if (match === "spelling") {
    const id = lookupId(vocab.spellings, spelling);
    return id === undefined ? [] : spellingSurfaces[id];
  }
  const formId = lookupId(vocab.forms, formKey(spelling));
  return formId === undefined ? [] : formSurfaces[formId];
};

/* ------------------------------ postings ------------------------------ */

const positionOf = (packed: number): number => packed & POSITION_MASK;
const isCapitalPosting = (packed: number): boolean => packed >= CAP_BIT;

/** Map of unitIndex -> matched token positions. */
type Slot = Map<number, number[]>;

/**
 * Add the (unit, position) pairs for the given surface ids to `out`, skipping
 * any unit in `skip` and, when `requireCapital` is set, any posting whose
 * capitalisation bit disagrees. Positions are stored with CAP_BIT masked off.
 */
const collectPostings = (
  postings: Postings,
  ids: number[],
  out: Slot,
  requireCapital: boolean | undefined,
  skip?: Set<number>,
): void => {
  const { offsets, pairs } = postings;
  for (const id of ids) {
    for (let i = offsets[id] * 2; i < offsets[id + 1] * 2; i += 2) {
      const unit = pairs[i];
      if (skip !== undefined && skip.has(unit)) continue;
      const packed = pairs[i + 1];
      if (
        requireCapital !== undefined &&
        isCapitalPosting(packed) !== requireCapital
      ) continue;
      const position = positionOf(packed);
      const positions = out.get(unit);
      if (positions === undefined) out.set(unit, [position]);
      else positions.push(position);
    }
  }
};

/**
 * Postings for one query word in the requested version. The primary index is
 * the edited reading text; for `original` the units that carry editorial
 * markup come from the overlay instead (with original-version positions), so
 * phrase matching stays consistent within every unit.
 */
const slotPostings = (
  artefacts: ServeArtefacts,
  word: QueryWord,
  options: SearchOptions,
  version: Version,
): Slot => {
  const ids = surfaceIds(artefacts, word.surface, options.match);
  const requireCapital = options.caseSensitive ? word.capital : undefined;
  const out: Slot = new Map();
  if (version === "original") {
    collectPostings(
      artefacts.postings,
      ids,
      out,
      requireCapital,
      artefacts.affectedUnits,
    );
    collectPostings(artefacts.overlayPostings, ids, out, requireCapital);
  } else {
    collectPostings(artefacts.postings, ids, out, requireCapital);
  }
  return out;
};

/* ------------------------------ matching ------------------------------ */

/**
 * Units where the phrase occurs, mapped to the positions of every matched
 * token (so a unit with two occurrences carries both runs). A single-word
 * phrase is just its slot; otherwise a start position in slot 0 matches when
 * slot i holds start + i for every later slot.
 */
const phraseMatches = (slots: Slot[]): Slot => {
  if (slots.length === 1) return slots[0];
  const out: Slot = new Map();
  for (const [unit, starts] of slots[0]) {
    const matched: number[] = [];
    for (const start of starts) {
      const ok = slots.every((slot, i) =>
        i === 0 || (slot.get(unit)?.includes(start + i) ?? false)
      );
      if (ok) {
        for (let i = 0; i < slots.length; i++) matched.push(start + i);
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

/**
 * Start positions of each phrase occurrence in a hit, recovered from its
 * matched token positions. A phrase of length `phraseLen` contributes a run of
 * that many consecutive positions (see `phraseMatches`); `positions` is sorted
 * and de-duplicated, so maximal runs of consecutive positions split into
 * occurrences `phraseLen` tokens apart. Natural-language phrases don't overlap,
 * so two occurrences never interleave within one run.
 */
export const occurrences = (
  positions: number[],
  phraseLen: number,
): number[] => {
  const starts: number[] = [];
  let i = 0;
  while (i < positions.length) {
    let runLen = 1;
    while (
      i + runLen < positions.length &&
      positions[i + runLen] === positions[i + runLen - 1] + 1
    ) runLen++;
    for (let j = 0; j + phraseLen <= runLen; j += phraseLen) {
      starts.push(positions[i] + j);
    }
    i += runLen;
  }
  return starts;
};

/**
 * Result filters. With no `edition`, search is scoped to each work's canonical
 * edition (so a corpus-wide query returns one hit per work, not one per
 * printing); `edition: "all"` searches every edition, and a year slug searches
 * just that one.
 */
export type Filters = { author?: string; work?: string; edition?: string };

export const ALL_EDITIONS = "all";

/* -------------------------------- BM25 -------------------------------- */

/** Saturation of term frequency, and the strength of length normalisation —
 * the conventional BM25 defaults. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** BM25 inverse document frequency (Robertson–Spärck-Jones, +1 inside the log
 * so it can never go negative for very common terms). */
const bm25Idf = (docs: number, df: number): number =>
  Math.log(1 + (docs - df + 0.5) / (df + 0.5));

/** BM25 saturating term frequency with document-length normalisation: `length`
 * is the unit's token count, `avgLength` the corpus mean. */
const bm25Tf = (tf: number, length: number, avgLength: number): number => {
  // bm25Tf only runs for a hit, which means the corpus has matched tokens, so
  // the mean unit length is positive.
  const norm = 1 - BM25_B + BM25_B * (length / avgLength);
  return (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
};

export const search = (
  artefacts: ServeArtefacts,
  q: string,
  filters: Filters = {},
  options: SearchOptions = DEFAULT_OPTIONS,
  version: Version = "edited",
): SearchHit[] => {
  const words = parseQuery(q);
  if (words.length === 0) return [];
  const slots = words.map((word) =>
    slotPostings(artefacts, word, options, version)
  );
  // A phrase can only match where every word does, so bail at the first gap.
  if (slots.some((slot) => slot.size === 0)) return [];
  const candidates = phraseMatches(slots);

  const { units, manifest } = artefacts;
  // BM25 constants for this query. The phrase is one term: its document
  // frequency is the number of units it matches (corpus-wide, before scoping),
  // and N and the mean unit length come from the manifest stats.
  const idf = bm25Idf(manifest.stats.units, candidates.size);
  const avgLength = manifest.stats.tokens / Math.max(1, manifest.stats.units);
  const hits: SearchHit[] = [];
  for (const [unitIndex, positions] of candidates) {
    // phraseMatches only records a unit with at least one match, so positions
    // is always non-empty here.
    const ref = manifest.editions[units.edition[unitIndex]];
    if (
      filters.author !== undefined && !ref.authors.includes(filters.author)
    ) continue;
    if (filters.work !== undefined && ref.work !== filters.work) continue;
    if (filters.edition === undefined) {
      if (!ref.canonical) continue;
    } else if (
      filters.edition !== ALL_EDITIONS && ref.edition !== filters.edition
    ) {
      continue;
    }
    const sorted = [...new Set(positions)].sort((a, b) => a - b);
    // Term frequency is the count of phrase occurrences (each is a run of
    // `words.length` consecutive matched positions; see `occurrences`).
    const tf = occurrences(sorted, words.length).length;
    const weight = units.isTitle[unitIndex] === 1 ? 3 : 1;
    hits.push({
      unitIndex,
      positions: sorted,
      score: weight * idf * bm25Tf(tf, units.tokenCount[unitIndex], avgLength),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.unitIndex - b.unitIndex);
  return hits;
};

/**
 * Character ranges of the matched tokens in a block's extracted text, for
 * highlightBlock. Runs of consecutive matched tokens (the phrase) become one
 * range, so the words between them are marked too.
 */
export const matchRanges = (
  text: string,
  positions: number[],
): HighlightRange[] => {
  const spans = tokenize(text);
  const ranges: HighlightRange[] = [];
  for (const position of positions) {
    // The positions index into this same tokenization (the version's), so the
    // span always exists.
    const span = spans[position]!;
    const last = ranges[ranges.length - 1];
    if (last !== undefined && spans[position - 1]?.end === last.end) {
      last.end = span.end;
    } else ranges.push({ start: span.start, end: span.end });
  }
  return ranges;
};
