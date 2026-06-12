/**
 * The corpus tokenizer and the type-level spelling normalisation.
 *
 * Two layers, kept strictly apart:
 *
 *  - TOKEN level (`tokenize`): where words begin and end in extracted text.
 *    Each occurrence carries its SURFACE form — case-folded but otherwise
 *    spelling-faithful ("Encrease" -> "encrease", "tho'" -> "tho'") — plus
 *    character offsets back into the text, so matches can be highlighted in
 *    the original. Changing this layer changes every stored offset, so any
 *    change must bump TOKENIZER_VERSION (invalidating built artefacts).
 *
 *  - TYPE level (`normalizeSurface`): what distinct surface forms count as
 *    the same word — accents, ligatures, apostrophes, and the variant
 *    spelling table ("encrease" -> "increase"). Applied to the ~50k distinct
 *    forms in the vocabulary, never to the corpus itself, so it can be
 *    improved freely without rebuilding corpus-scale artefacts.
 */

import variantsJson from "./variants.json" with { type: "json" };

export const TOKENIZER_VERSION = 1;

const VARIANTS = new Map<string, string>(
  Object.entries(variantsJson).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && !entry[0].startsWith("__"),
  ),
);

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

/**
 * Fold a free-standing word (e.g. from a search query) exactly the way
 * `tokenize` folds corpus text. Returns "" for non-word input.
 */
export const surfaceForm = (word: string): string =>
  tokenize(word)[0]?.surface ?? "";

/**
 * Type-level spelling normalisation: surface form -> normalised form.
 * Strips apostrophes and accents, expands ligatures, then applies the
 * variant-spelling table, so old and modern spellings share a normalised
 * form ("shew" and "show" -> "show").
 */
export const normalizeSurface = (surface: string): string => {
  const base = surface
    .replace(/['’]/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe");
  return VARIANTS.get(base) ?? base;
};
