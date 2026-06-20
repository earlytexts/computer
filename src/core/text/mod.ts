/**
 * The public API of the text engine: the pure functions (extraction, highlight
 * injection, tokenization and the spelling/form/lemma type layers, search, diff,
 * edition comparison, concordance) that the build and serve sides are allowed to
 * use. `build/` and `serve/` import only from here; the individual `text/*.ts`
 * leaves are internal to the engine.
 *
 * This is the seam over `text/`: a stable, pure surface to characterize the
 * engine through, so the algorithmic leaves below it (the stemmer, the Myers
 * diff, the extraction/offset traversal) can be refactored freely behind it.
 * Direct characterization tests still reach into the leaves by design — this is
 * the contract for production code, not a wall against the engine's own tests.
 */

/* extraction & block shaping */
export {
  blockText,
  EXTRACTION_VERSION,
  hasEditorial,
  highlightBlock,
  resolveBlock,
} from "./text.ts";
export type { HighlightRange } from "./text.ts";

/* tokenization & the spelling/form/lemma type layers */
export {
  buildSurfaceLemma,
  formKey,
  normalizeSpelling,
  tokenize,
  TOKENIZER_VERSION,
} from "./tokenize.ts";
export type { TokenSpan } from "./tokenize.ts";

/* search */
export { matchRanges, occurrences, parseQuery, search } from "./search.ts";
export type { MatchLevel, SearchHit, SearchOptions } from "./search.ts";

/* diff, edition comparison, concordance */
export { diffBlocks, diffToBlocks } from "./diff.ts";
export { alignSections, findSectionByKey, pathKey } from "./compare.ts";
export type { AlignedSection } from "./compare.ts";
export { compareLines, lineParts } from "./concordance.ts";
export type { Sort } from "./concordance.ts";
