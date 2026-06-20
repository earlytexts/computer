/**
 * Concordance / KWIC (keyword-in-context) line building.
 *
 * Search returns one hit per matching block; a concordance instead shows one
 * line per *occurrence*, with the keyword centred between trimmed, fixed-width
 * windows of context (a few words each side). The lines can be sorted by the
 * words immediately left or right of the keyword, which clusters fixed phrases
 * ("cause and effect") and governing terms ("first cause", "final cause") — the
 * usual way to study how a word is used across a corpus.
 *
 * This module is pure: given a block's extracted text, its tokenization, and an
 * occurrence's start token, it slices the context windows; the orchestration
 * (reading blocks, paginating) lives in api.ts.
 */

import type { TokenSpan } from "./tokenize.ts";

/** How lines are ordered: corpus order, or by the words left/right of the
 * keyword (nearest first). */
export type Sort = "position" | "left" | "right";

/** The sliced parts of one concordance line. */
export type LineParts = {
  /** Context to the left of the keyword, in reading order ("" at block start). */
  left: string;
  /** The matched phrase, verbatim from the block's text. */
  keyword: string;
  /** Context to the right of the keyword, in reading order ("" at block end). */
  right: string;
  /** True when context was cut at the word limit rather than the block edge. */
  leftTruncated: boolean;
  rightTruncated: boolean;
  /** Case-folded context surfaces, nearest-out, used only as sort keys. */
  leftWords: string[];
  rightWords: string[];
};

/**
 * Build the KWIC parts for the occurrence whose first token is `start`, given
 * the block's text and token spans, the phrase length, and how many context
 * words to keep on each side.
 */
export const lineParts = (
  text: string,
  spans: TokenSpan[],
  start: number,
  phraseLen: number,
  context: number,
): LineParts => {
  const last = spans.length - 1;
  const end = start + phraseLen - 1; // last token of the keyword
  const leftFrom = Math.max(0, start - context);
  const rightTo = Math.min(last, end + context);
  const leftWords: string[] = [];
  for (let i = start - 1; i >= leftFrom; i--) leftWords.push(spans[i].surface);
  const rightWords: string[] = [];
  for (let i = end + 1; i <= rightTo; i++) rightWords.push(spans[i].surface);
  return {
    left: start > 0
      ? text.slice(spans[leftFrom].start, spans[start - 1].end)
      : "",
    keyword: text.slice(spans[start].start, spans[end].end),
    right: end < last
      ? text.slice(spans[end + 1].start, spans[rightTo].end)
      : "",
    leftTruncated: leftFrom > 0,
    rightTruncated: rightTo < last,
    leftWords,
    rightWords,
  };
};

/** Lexicographic comparison of two nearest-first context-word lists. */
const compareWords = (a: string[], b: string[]): number => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};

/** What `compareLines` needs to order occurrences. */
export type Sortable = {
  unitIndex: number;
  start: number;
  leftWords: string[];
  rightWords: string[];
};

/**
 * Comparator for the chosen sort. `position` is corpus order (block then
 * occurrence); `left`/`right` order by the context words nearest the keyword,
 * falling back to corpus order so the result is stable.
 */
export const compareLines =
  (sort: Sort) => (a: Sortable, b: Sortable): number =>
    (sort === "left"
      ? compareWords(a.leftWords, b.leftWords)
      : sort === "right"
      ? compareWords(a.rightWords, b.rightWords)
      : 0) ||
    a.unitIndex - b.unitIndex ||
    a.start - b.start;
