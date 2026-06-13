/**
 * Full-text search over the built artefacts (see artefacts.ts).
 *
 * The searchable unit is a single block (paragraph, footnote, or title), so
 * results link straight to the matching text. The whole query is matched as
 * one phrase — its words must appear consecutively, in order — without the
 * reader having to quote it (boolean and prefix queries are deliberately left
 * for later). Matching is tolerant by default and tightened by two
 * independent options:
 *
 *   - exactSpelling: off (default) matches through the normalised layer, so
 *     old and modern spellings and inflections find each other ("connection
 *     between cause and effect" matches "connexion betwixt causes and
 *     effects"); on matches the surface form as written ("enquiry" ≠
 *     "inquiry", "causes" ≠ "cause").
 *   - caseSensitive: off (default) ignores case; on requires each word's
 *     initial capitalisation to agree with the text (so "Hume" skips lowercase
 *     "hume"). Resolved from a capitalisation bit on every posting (CAP_BIT),
 *     so it stays a pure in-memory filter — no per-hit text reads.
 *
 * Either way the index is keyed by SURFACE form (distinct case-folded
 * spellings); a tolerant word is expanded to every surface sharing its
 * normalised form, an exact word to its own surface only. Results can be
 * filtered by author, work, and edition.
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
} from "./artefacts.ts";
import type { HighlightRange } from "./text.ts";
import type { Version } from "../types.ts";
import { normalizeSurface, tokenize } from "./tokenize.ts";

export type SearchOptions = {
  /** Match the surface form as written, skipping variant/inflection folding. */
  exactSpelling: boolean;
  /** Require each query word's initial capitalisation to agree with the text. */
  caseSensitive: boolean;
};

export const DEFAULT_OPTIONS: SearchOptions = {
  exactSpelling: false,
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

/** Surface ids matching one query word under the spelling option: the word's
 * own surface (exact) or every surface sharing its normalised form (tolerant). */
const surfaceIds = (
  artefacts: ServeArtefacts,
  surface: string,
  exactSpelling: boolean,
): number[] => {
  if (exactSpelling) {
    const id = lookupId(artefacts.vocab.surfaces, surface);
    return id === undefined ? [] : [id];
  }
  const normId = lookupId(artefacts.vocab.norms, normalizeSurface(surface));
  return normId === undefined ? [] : artefacts.normSurfaces[normId];
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
  const ids = surfaceIds(artefacts, word.surface, options.exactSpelling);
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

export type Filters = { author?: string; work?: string; edition?: string };

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
  const hits: SearchHit[] = [];
  for (const [unitIndex, positions] of candidates) {
    if (positions.length === 0) continue;
    const ref = manifest.editions[units.edition[unitIndex]];
    if (filters.author !== undefined && ref.author !== filters.author) continue;
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
    const span = spans[position];
    if (span === undefined) continue;
    const last = ranges[ranges.length - 1];
    if (last !== undefined && spans[position - 1]?.end === last.end) {
      last.end = span.end;
    } else ranges.push({ start: span.start, end: span.end });
  }
  return ranges;
};
