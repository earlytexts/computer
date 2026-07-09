/**
 * The corpus tokenizer: where words begin and end in extracted text.
 *
 * Each occurrence carries its SURFACE form — case-folded but otherwise
 * spelling-faithful ("Encrease" -> "encrease", "tho'" -> "tho'") — plus
 * character offsets back into the text, so matches can be highlighted in the
 * original. Changing this layer changes every stored offset, so any change must
 * bump TOKENIZER_VERSION (invalidating built artefacts).
 *
 * This is identity only — which character runs are words, folded how. Everything
 * editorial about a word (its normalised spelling, its lemma, whether it is
 * ambiguous) is the corpus dictionary's, consumed from the compiled catalogue at
 * build time (see readings.ts) rather than computed here by heuristic. The old
 * variant table, Porter stemmer, and lemma heuristic are gone; the dictionary
 * replaces them outright.
 */

// 2: query is matched as a phrase; postings carry a capitalisation bit.
// 3: (was) productive spelling-class folds around the stemmer. The stemmer and
// variant table are retired in favour of the corpus dictionary, but the token
// layer — surfaces and offsets — is untouched, so the version stays at 3.
export const TOKENIZER_VERSION = 3;

const WORD_RE = /[\p{L}\p{N}'’æœ-]+/giu;

export type TokenSpan = {
  /** Case-folded, spelling-faithful form of the occurrence. */
  surface: string;
  /** [start, end) character offsets into the tokenized text. */
  start: number;
  end: number;
};

/**
 * Tokenize extracted plain text into surface forms with offsets. Hyphens at
 * a token's edges are trimmed (and the offsets tightened); internal hyphens
 * and apostrophes are kept, so "school-men" and "tho'" are single tokens.
 */
export const tokenize = (text: string): TokenSpan[] => {
  const spans: TokenSpan[] = [];
  for (const match of text.matchAll(WORD_RE)) {
    let start = match.index;
    let end = start + match[0].length;
    while (start < end && text[start] === "-") start++;
    while (end > start && text[end - 1] === "-") end--;
    if (start === end) continue;
    spans.push({ surface: text.slice(start, end).toLowerCase(), start, end });
  }
  return spans;
};
