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
  tokenContexts,
} from "./text.ts";
export type { ContextSpan, HighlightRange } from "./text.ts";

/* tokenization (word identity) */
export {
  joinTokens,
  multiWordKeys,
  tokenize,
  TOKENIZER_VERSION,
} from "./tokenize.ts";
export type { TokenSpan } from "./tokenize.ts";

/* dictionary readings (per-occurrence spelling/lemma resolution) */
export { EXEMPT, resolveTokenReadings, surfaceReadings } from "./readings.ts";

/* search */
export {
  matchRanges,
  occurrences,
  parseQuery,
  scopeEditions,
  search,
  surfaceIds,
} from "./search.ts";
export type { MatchLevel, SearchHit, SearchOptions } from "./search.ts";

/* keyness (statistical over-representation) */
export { keyness, OUT, REFERENCE, TARGET } from "./keywords.ts";
export type {
  KeyMode,
  KeynessOptions,
  KeynessResult,
  KeynessRow,
} from "./keywords.ts";

/* collocations (positional co-occurrence) */
export { collocations, IN_SCOPE } from "./collocations.ts";
export type {
  CollocationOptions,
  CollocationResult,
  CollocationRow,
} from "./collocations.ts";

/* similarity (cosine over the TF-IDF document vectors) */
export { similar } from "./similar.ts";
export type { SimilarOptions, SimilarRow } from "./similar.ts";

/* topic models (aggregating the NMF document-topic mix) */
export { aggregateMix } from "./topics.ts";

/* diff, edition comparison, concordance */
export { diffBlocks, diffToBlocks } from "./diff.ts";
export { alignSections, findSectionByKey } from "./compare.ts";
export type { AlignedSection, SectionNode } from "./compare.ts";
export { compareLines, lineParts } from "./concordance.ts";
export type { Sort } from "./concordance.ts";
