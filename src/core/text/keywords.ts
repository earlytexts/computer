/**
 * Keyness over the built artefacts: the words a target subcorpus uses more than
 * the rest of the corpus does, ranked by statistical over-representation.
 *
 * Unlike search/frequency/concordance, this takes no query — it is a discovery
 * tool. Given a partition of the corpus's units into a TARGET set and a
 * REFERENCE set (the serve layer decides the partition from author/work/edition
 * scope; here it arrives as a per-unit `scope` array), it counts how often every
 * term occurs in each side and scores the difference with two complementary
 * measures, the standard pairing in corpus linguistics:
 *
 *   - log-likelihood (Dunning's G²): a significance test — how much evidence
 *     there is that the term's rate differs between target and reference. It
 *     scales with sample size, so on its own it ranks frequent words highly even
 *     for a tiny effect (the same failure mode as a raw count).
 *   - log-ratio: the effect size — log₂ of the ratio of the term's relative
 *     frequency in the target to its relative frequency in the reference. A zero
 *     reference count is smoothed (Hardie) so the ratio stays finite.
 *
 * Results are the terms over-represented in the target (positive log-ratio),
 * ranked by G². No stop-word list is applied: function words tend to occur at
 * similar rates in like prose and so score low, while a genuine stylistic marker
 * ("betwixt" for "between") is exactly the kind of distinctive vocabulary the
 * measure is meant to surface.
 *
 * Terms are grouped at one of three levels (the `mode`): the citation-form LEMMA
 * (default — "causes"/"caused" → "cause"), the inflection FORM bucket, or the
 * EXACT spelling as written. Counting is over the same index search uses, so
 * the `version` handling (edited primary, original via the overlay) matches.
 */

import { type Postings, readingOf, type ServeArtefacts } from "../artefacts.ts";
import type { Version } from "../../types.ts";

/** Which type level terms are grouped and reported at. */
export type KeyMode = "lemma" | "form" | "exact";

export type KeynessOptions = {
  /** Term grouping level (default "lemma"). */
  mode: KeyMode;
  /** Which text to count over: edited reading text or the original. */
  version: Version;
  /** Minimum target occurrences for a term to be scored (noise floor). */
  minCount: number;
  /** Maximum rows to return, after ranking by log-likelihood. */
  limit: number;
};

export type KeynessRow = {
  /** The lemma, form bucket, or surface form (per `mode`). */
  term: string;
  /** Occurrences in the target subcorpus. */
  target: number;
  /** Occurrences in the reference subcorpus. */
  reference: number;
  /** Dunning's log-likelihood (G²): the significance of the difference. */
  logLikelihood: number;
  /** log₂ of the relative-frequency ratio (target / reference): the effect size. */
  logRatio: number;
};

export type KeynessResult = {
  /** Total tokens in the target subcorpus (the rate denominator). */
  targetTokens: number;
  /** Total tokens in the reference subcorpus. */
  referenceTokens: number;
  /** Over-represented terms, ranked by log-likelihood descending. */
  rows: KeynessRow[];
};

/** Per-unit partition: 0 = out of scope, 1 = target, 2 = reference. */
export const OUT = 0;
export const TARGET = 1;
export const REFERENCE = 2;

/** The groups an occurrence counts under, keyed by the group's label. */
type Grouper = {
  labels: string[];
  /** The group ids a posting (surface id + its resolved reading) contributes
   * to — usually one, more for a contraction counted at the lemma level. */
  groupsFor: (id: number, reading: number) => number[];
};

/**
 * The grouping for a keyness mode. `exact` counts each occurrence under its
 * printed surface, independent of reading. `form` and `lemma` both count under
 * the resolved reading's citation lemma(s) — the two collapsed now that the
 * register supplies curated lemmas (a surface's occurrences can count under
 * different lemmas as their readings resolve; a contraction counts under each of
 * its words' lemmas). Labels are the corpus's distinct lemma words.
 */
export const grouping = (
  artefacts: ServeArtefacts,
  mode: KeyMode,
): Grouper => {
  const { vocab, lemmas } = artefacts;
  if (mode === "exact") {
    return { labels: vocab.surfaces, groupsFor: (id) => [id] };
  }
  const index = new Map(lemmas.map((lemma, group) => [lemma, group]));
  return {
    labels: lemmas,
    groupsFor: (id, reading) =>
      readingOf(vocab, id, reading).map((word) => index.get(word.lemma)!),
  };
};

/**
 * A static surface -> group map at a mode's level, grouping each surface by its
 * *default* reading (its first lemma word for `lemma`/`form`, its own spelling
 * for `exact`). For consumers that count over the surface-keyed token stream
 * (collocations, whose `tokens.bin` carries no per-occurrence reading), where a
 * surface's default reading is the right approximation.
 */
export const surfaceGroups = (
  artefacts: ServeArtefacts,
  mode: KeyMode,
): { groupOf: Int32Array; labels: string[] } => {
  const { vocab, lemmas } = artefacts;
  const surfaces = vocab.surfaces.length;
  const groupOf = new Int32Array(surfaces);
  if (mode === "exact") {
    for (let id = 0; id < surfaces; id++) groupOf[id] = id;
    return { groupOf, labels: vocab.surfaces };
  }
  const index = new Map(lemmas.map((lemma, group) => [lemma, group]));
  for (let id = 0; id < surfaces; id++) {
    groupOf[id] = index.get(vocab.readings[id][0][0].lemma)!;
  }
  return { groupOf, labels: lemmas };
};

/**
 * Accumulate every occurrence into the target/reference tallies for the group(s)
 * of its resolved reading, honouring the unit partition and skipping any unit in
 * `skip` (used to omit overlay-covered units from the primary index when
 * counting original).
 */
const tally = (
  postings: Postings,
  groupsFor: Grouper["groupsFor"],
  scope: Int8Array,
  target: Float64Array,
  reference: Float64Array,
  skip?: Set<number>,
): void => {
  const { offsets, pairs, readings } = postings;
  const surfaces = offsets.length - 1;
  for (let id = 0; id < surfaces; id++) {
    for (let p = offsets[id]; p < offsets[id + 1]; p++) {
      const unit = pairs[p * 2];
      if (skip !== undefined && skip.has(unit)) continue;
      const where = scope[unit];
      if (where === OUT) continue;
      for (const group of groupsFor(id, readings[p])) {
        if (where === TARGET) target[group]++;
        else reference[group]++;
      }
    }
  }
};

const LOG2 = Math.log(2);

/** A term's contribution to G²: 0 when it never occurs on that side. */
const llTerm = (observed: number, expected: number): number =>
  observed === 0 ? 0 : observed * Math.log(observed / expected);

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Score the keyness of every term given the unit partition. Pure over the
 * artefacts: the serve layer builds `scope` from request parameters and reads
 * back the ranked rows.
 */
export const keyness = (
  artefacts: ServeArtefacts,
  scope: Int8Array,
  options: KeynessOptions,
): KeynessResult => {
  const { units, postings, overlayPostings, affectedUnits } = artefacts;

  let targetTokens = 0;
  let referenceTokens = 0;
  for (let unit = 0; unit < scope.length; unit++) {
    const where = scope[unit];
    if (where === TARGET) targetTokens += units.tokenCount[unit];
    else if (where === REFERENCE) referenceTokens += units.tokenCount[unit];
  }
  // No comparison is possible without text on both sides.
  if (targetTokens === 0 || referenceTokens === 0) {
    return { targetTokens, referenceTokens, rows: [] };
  }

  const { groupsFor, labels } = grouping(artefacts, options.mode);
  const target = new Float64Array(labels.length);
  const reference = new Float64Array(labels.length);
  if (options.version === "original") {
    // The overlay carries original-version postings for the edited units; take
    // those units from it and the rest from the primary index (mirrors search).
    tally(postings, groupsFor, scope, target, reference, affectedUnits);
    tally(overlayPostings, groupsFor, scope, target, reference);
  } else {
    tally(postings, groupsFor, scope, target, reference);
  }

  const total = targetTokens + referenceTokens;
  const rows: KeynessRow[] = [];
  for (let group = 0; group < labels.length; group++) {
    const a = target[group];
    if (a < options.minCount) continue;
    const b = reference[group];
    // Over-representation only: the target's rate must exceed the reference's.
    if (a / targetTokens <= b / referenceTokens) continue;

    const expectedTarget = (targetTokens * (a + b)) / total;
    const expectedReference = (referenceTokens * (a + b)) / total;
    const logLikelihood = 2 *
      (llTerm(a, expectedTarget) + llTerm(b, expectedReference));

    // Smooth a zero reference count by half an occurrence so the ratio is finite.
    const targetRate = a / targetTokens;
    const referenceRate = (b === 0 ? 0.5 : b) / referenceTokens;
    const logRatio = Math.log(targetRate / referenceRate) / LOG2;

    rows.push({
      term: labels[group],
      target: a,
      reference: b,
      logLikelihood: round2(logLikelihood),
      logRatio: round2(logRatio),
    });
  }

  rows.sort((x, y) =>
    y.logLikelihood - x.logLikelihood ||
    y.logRatio - x.logRatio ||
    // terms are distinct group labels, so they never tie.
    (x.term < y.term ? -1 : 1)
  );
  return {
    targetTokens,
    referenceTokens,
    rows: rows.slice(0, options.limit),
  };
};
