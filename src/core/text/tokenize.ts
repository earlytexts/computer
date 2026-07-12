/**
 * The corpus tokenizer: where words begin and end in extracted text.
 *
 * Word identity — which character runs are words, and how two printed tokens
 * fold to the same surface — is the corpus's, imported from
 * `@earlytexts/corpus/wire` (words.ts) rather than reproduced here, so there is
 * one definition of "a word" across the write and read sides. This layer adds
 * only what the read side needs on top: the character offsets to highlight a
 * match back in the block, and the register-driven multi-word join, run over the
 * base spans with the very `joinMultiWord` the corpus runs for accounting — so
 * the two tokenizations of a fixed unit (`a priori`) cannot disagree.
 *
 * Each occurrence carries its SURFACE form — folded through the corpus's `fold`
 * (so `Encrease` → `encrease`, and the pronoun `I` is preserved apart from the
 * numeral `i`) — plus character offsets into the text, so matches can be
 * highlighted in the original. Changing this layer changes every stored offset,
 * so any change must bump TOKENIZER_VERSION (invalidating built artefacts).
 *
 * This is identity only. Everything editorial about a word — its normalised
 * spelling, its lemma, whether it is ambiguous, and which adjacent words are one
 * unit — is the corpus dictionary's, consumed from the compiled catalogue (see
 * readings.ts) rather than computed here by heuristic.
 */

import {
  fold,
  joinMultiWord,
  type JoinOps,
  wordPattern,
} from "@earlytexts/corpus/wire";

// 2: query is matched as a phrase; postings carry a capitalisation bit.
// 3: (was) productive spelling-class folds around a stemmer, since retired.
// 4: two internal joiners of the computer's own regex — a period before a
// letter and the `~` a non-breaking space extracted to.
// 5: word identity now imported from the corpus (`wordPattern`/`fold`), a
// single shared definition. The `~` marker is gone (a non-breaking space
// extracts to a plain space); a multi-word unit is fused by `joinTokens` from
// the register instead. Consequences vs. 4: hyphens split (`school-men` is two
// tokens) and the pronoun `I` no longer folds onto the numeral `i`.
export const TOKENIZER_VERSION = 5;

export type TokenSpan = {
  /** Folded, spelling-faithful form of the occurrence (a fused unit keeps its
   * internal spaces, `a priori`). */
  surface: string;
  /** [start, end) character offsets into the tokenized text. */
  start: number;
  end: number;
};

/**
 * Tokenize extracted plain text into surface forms with offsets, using the
 * corpus word alphabet. A token is a run of letters/digits and internal
 * apostrophes, with a period that falls before a letter kept (`i.e`); hyphens
 * and every kind of space separate. The surface is the corpus fold of the run.
 */
export const tokenize = (text: string): TokenSpan[] => {
  const spans: TokenSpan[] = [];
  for (const match of text.matchAll(wordPattern)) {
    const start = match.index;
    spans.push({
      surface: fold(match[0]),
      start,
      end: start + match[0].length,
    });
  }
  return spans;
};

/** The multi-word surfaces among `surfaces` — the register keys a join can fuse
 * a run into (those with an internal space). */
export const multiWordKeys = (surfaces: Iterable<string>): Set<string> =>
  new Set([...surfaces].filter((surface) => surface.includes(" ")));

/**
 * Fuse each run of adjacent base spans that a registered multi-word surface
 * names into one span — the same greedy, longest-first join the corpus runs
 * over the block tree (`joinMultiWord`). Adjacency is read straight from the
 * text: two spans join only when nothing but inter-word space (never a newline
 * or punctuation) separates them. The fused span covers the whole printed unit,
 * so a highlight marks all of it and its position lines up with the build's.
 */
export const joinTokens = (
  spans: TokenSpan[],
  text: string,
  keys: ReadonlySet<string>,
): TokenSpan[] => {
  if (keys.size === 0) return spans;
  type Adjacent = { span: TokenSpan; joinsLeft: boolean };
  const items: Adjacent[] = spans.map((span, index) => ({
    span,
    joinsLeft: index > 0 &&
      /^ *$/.test(text.slice(spans[index - 1].end, span.start)),
  }));
  const ops: JoinOps<Adjacent> = {
    folded: (item) => item.span.surface,
    joinsLeft: (item) => item.joinsLeft,
    merge: (run) => ({
      span: {
        surface: run.map((item) => item.span.surface).join(" "),
        start: run[0].span.start,
        end: run[run.length - 1].span.end,
      },
      joinsLeft: run[0].joinsLeft,
    }),
  };
  return joinMultiWord(items, keys, ops).map((item) => item.span);
};
