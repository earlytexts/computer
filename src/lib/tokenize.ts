/**
 * The corpus tokenizer and the type-level spelling/form normalisation.
 *
 * Layers, kept strictly apart. The token layer is gated by TOKENIZER_VERSION;
 * the type layers are gated by VOCAB_VERSION (see artefacts.ts), because they
 * change only the vocabulary's derived buckets, not the stored offsets.
 *
 *  - TOKEN level (`tokenize`): where words begin and end in extracted text.
 *    Each occurrence carries its SURFACE form — case-folded but otherwise
 *    spelling-faithful ("Encrease" -> "encrease", "tho'" -> "tho'") — plus
 *    character offsets back into the text, so matches can be highlighted in
 *    the original. Changing this layer changes every stored offset, so any
 *    change must bump TOKENIZER_VERSION (invalidating built artefacts).
 *
 * The type layers run in SERIES, each consuming the previous, and — until the
 * last — each producing a real, well-formed word. Applied to the ~50k distinct
 * forms in the vocabulary, never to the corpus itself:
 *
 *  - SPELLING (`normalizeSpelling`): orthography only, inflection preserved.
 *    Fold accents/ligatures/apostrophes, map old spellings to modern through
 *    the variant table ("encrease" -> "increase"), then collapse productive
 *    spelling classes by rule ("organise" -> "organize", "honour" -> "honor").
 *    Output is the canonical spelling: "encreasing" -> "increasing", NOT a
 *    stem. This is the spelling-tolerant search bucket and the input to both
 *    lemmatisation and the form bucket.
 *
 *  - FORM (`formKey`): the inflection-collapsing recall bucket, built ON the
 *    canonical spelling. For now just a Porter stem of the spelling
 *    ("increasing" -> "increas") — a quick-and-dirty stand-in for a lemmatiser;
 *    as the lemmatiser (artefacts.ts) gains coverage it can prefer the real
 *    lemma. Only ever a bucket key, never displayed, so it may read oddly.
 *
 * Lemmatisation (a real citation-form headword, for statistics) is the third
 * type layer and lives in artefacts.ts, because it checks candidate bases
 * against the corpus spelling vocabulary; it too runs on the canonical
 * spelling, so it never has to know about archaic orthography.
 */

import variantsJson from "./variants.json" with { type: "json" };

// 2: query is matched as a phrase; postings carry a capitalisation bit;
// normalisation now Porter-stems after the variant table (plurals/inflections).
// 3: productive spelling-class folds (-ize/-ise, -our/-or) around the stemmer.
// The series split (spelling/form/lemma) is a VOCAB_VERSION change, not a
// tokenizer change: surfaces and offsets are untouched, so this stays at 3.
export const TOKENIZER_VERSION = 3;

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

/* -------------------------- Porter stemming -------------------------- */

// The classic Porter (1980) algorithm, used to collapse inflections and
// plurals so that "cause"/"causes", "effect"/"effects" and
// "connect"/"connection" share a normalised form. Applied after the variant
// table (so old spellings reach their modern stem first) and only to the
// vocabulary, never to corpus text. A faithful port of Porter's reference
// implementation, in the repo's arrow-function style.

const CONS = "[^aeiou]";
const VOWEL = "[aeiouy]";
const CONS_SEQ = CONS + "[^aeiouy]*";
const VOWEL_SEQ = VOWEL + "[aeiou]*";
// measure tests: mgr0 = m>0, mgr1 = m>1, meq1 = m==1.
const MGR0 = new RegExp(`^(${CONS_SEQ})?${VOWEL_SEQ}${CONS_SEQ}`);
const MGR1 = new RegExp(
  `^(${CONS_SEQ})?${VOWEL_SEQ}${CONS_SEQ}${VOWEL_SEQ}${CONS_SEQ}`,
);
const MEQ1 = new RegExp(
  `^(${CONS_SEQ})?${VOWEL_SEQ}${CONS_SEQ}(${VOWEL_SEQ})?$`,
);
const HAS_VOWEL = new RegExp(`^(${CONS_SEQ})?${VOWEL}`);
const CVC = new RegExp(`^${CONS_SEQ}${VOWEL}[^aeiouwxy]$`);

const STEP2 = new Map<string, string>(Object.entries({
  ational: "ate",
  tional: "tion",
  enci: "ence",
  anci: "ance",
  izer: "ize",
  bli: "ble",
  alli: "al",
  entli: "ent",
  eli: "e",
  ousli: "ous",
  ization: "ize",
  ation: "ate",
  ator: "ate",
  alism: "al",
  iveness: "ive",
  fulness: "ful",
  ousness: "ous",
  aliti: "al",
  iviti: "ive",
  biliti: "ble",
  logi: "log",
}));
const STEP3 = new Map<string, string>(Object.entries({
  icate: "ic",
  ative: "",
  alize: "al",
  iciti: "ic",
  ical: "ic",
  ful: "",
  ness: "",
}));
const STEP2_RE =
  /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const STEP3_RE = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
const STEP4_RE =
  /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;

export const stem = (word: string): string => {
  if (word.length < 3) return word;
  let w = word;
  const leadingY = w[0] === "y";
  if (leadingY) w = "Y" + w.slice(1); // a leading y is a consonant

  // Step 1a (plurals)
  if (/^(.+?)(ss|i)es$/.test(w)) w = w.replace(/^(.+?)(ss|i)es$/, "$1$2");
  else if (/^(.+?)([^s])s$/.test(w)) w = w.replace(/^(.+?)([^s])s$/, "$1$2");

  // Step 1b (-eed/-ed/-ing)
  const eed = /^(.+?)eed$/.exec(w);
  if (eed !== null) {
    if (MGR0.test(eed[1])) w = w.slice(0, -1);
  } else {
    const edIng = /^(.+?)(ed|ing)$/.exec(w);
    if (edIng !== null && HAS_VOWEL.test(edIng[1])) {
      w = edIng[1];
      if (/(at|bl|iz)$/.test(w)) w = w + "e";
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (CVC.test(w)) w = w + "e";
    }
  }

  // Step 1c (y -> i)
  const y = /^(.+?)y$/.exec(w);
  if (y !== null && HAS_VOWEL.test(y[1])) w = y[1] + "i";

  // Step 2
  const m2 = STEP2_RE.exec(w);
  if (m2 !== null && MGR0.test(m2[1])) w = m2[1] + STEP2.get(m2[2]);

  // Step 3
  const m3 = STEP3_RE.exec(w);
  if (m3 !== null && MGR0.test(m3[1])) w = m3[1] + STEP3.get(m3[2]);

  // Step 4 (strip remaining suffixes when m>1)
  const m4 = STEP4_RE.exec(w);
  const ion = /^(.+?)(s|t)(ion)$/.exec(w);
  if (m4 !== null) {
    if (MGR1.test(m4[1])) w = m4[1];
  } else if (ion !== null && MGR1.test(ion[1] + ion[2])) {
    w = ion[1] + ion[2];
  }

  // Step 5a (trailing e)
  const e = /^(.+?)e$/.exec(w);
  if (e !== null) {
    const s = e[1];
    if (MGR1.test(s) || (MEQ1.test(s) && !CVC.test(s))) w = s;
  }
  // Step 5b (double l)
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1);

  return leadingY ? "y" + w.slice(1) : w;
};

/**
 * Fold a surface to the base form the variant table is keyed on: strip
 * apostrophes and accents, expand ligatures. This is the first step of
 * `normalizeSpelling`, before the variant table and the productive folds; the
 * variants curation tool (dev/variants.ts) keys new overrides on exactly
 * this form, so it must stay the single source of truth.
 */
export const foldBase = (surface: string): string =>
  surface
    .replace(/['’]/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe");

/**
 * Productive spelling-class folds: orthographic classes where the two
 * spellings are always the *same word*, so collapsing them by rule (rather
 * than one variant-table row per word) keeps the whole family in one canonical
 * spelling consistently. Deliberately narrow; en-/in- is excluded because it
 * distinguishes real words (ensure/insure, endure/indure). Both run on the
 * variant-mapped base, preserving any inflectional ending.
 *
 *  - `-ise/-ize`: canonicalise to `-ize` (commoner than `-ise` in early modern
 *    British print). The 3-char stem guard leaves rise/wise/advise alone.
 *  - `-our/-or`: canonicalise to `-or` ("honour" -> "honor"). The 3-char guard
 *    leaves our/four/hour/flour alone.
 *
 * These shape the canonical spelling, so a misfire (e.g. "exercise" ->
 * "exercize") yields a slightly odd canonical form; harmless as a search
 * bucket, and curable per-word via the variant table if it ever surfaces in
 * displayed lemma statistics.
 */
const ISE_RE = /([a-z]{3,})is(e|es|ed|ing|ation|ations|er|ers)$/;
const OUR_RE = /([a-z]{3,})our$/;

/**
 * SPELLING layer: surface -> canonical modern spelling, inflection preserved.
 * Fold to the variant-table base, map old spelling to modern, then apply the
 * productive folds. Output is a real word ("encreasing" -> "increasing"); it
 * is the spelling-tolerant search bucket and the input to `formKey` and to
 * lemmatisation.
 */
export const normalizeSpelling = (surface: string): string => {
  const base = foldBase(surface);
  const mapped = VARIANTS.get(base) ?? base;
  return mapped.replace(ISE_RE, "$1iz$2").replace(OUR_RE, "$1or");
};

/**
 * FORM layer: canonical spelling -> inflection-collapsing recall bucket. For
 * now a plain Porter stem of the spelling ("increasing" -> "increas"); a
 * quick-and-dirty stand-in until the lemmatiser (artefacts.ts) is trusted
 * enough to take over this slot. Never displayed, so a non-word stem is fine.
 */
export const formKey = (spelling: string): string => stem(spelling);
