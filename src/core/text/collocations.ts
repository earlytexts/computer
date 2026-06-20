/**
 * Collocations over the built artefacts: given a NODE word, the words that
 * occur near it more often than chance — the conceptual neighbourhood of a
 * term ("what clusters around _liberty_, _cause_, _passion_").
 *
 * Where keyness (keywords.ts) finds distinctive *terms* by comparing a target
 * subcorpus with a reference, collocation finds distinctive *pairings* by
 * comparing how often a word appears in the node's company with how often it
 * appears at all. It is therefore *positional*: the inverted index alone cannot
 * say what stands next to a given token, so the node's units are read from the
 * ordered token stream (tokens.bin) and a window of ±N tokens is walked around
 * each node occurrence. Windows are clamped to their unit (a block), so context
 * never bleeds across a paragraph boundary, and overlapping windows count each
 * physical context position once — so a collocate's co-occurrence count can
 * never exceed its total frequency, keeping every contingency table consistent.
 *
 * For each candidate collocate three complementary association measures are
 * reported, the standard toolkit in corpus linguistics — they disagree by
 * design, so a client can rank by whichever question it is asking:
 *
 *   - PMI (pointwise mutual information): log₂ of observed over expected
 *     co-occurrence. Pure effect size; favours rare, tightly-bound pairs (the
 *     vivid lexical neighbours) but is noisy for low counts.
 *   - log-likelihood (Dunning's G²): a 2×2 significance test — how much
 *     evidence there is that the pairing is non-random. Scales with frequency,
 *     so it surfaces confident, often grammatical, collocates.
 *   - t-score: (O − E) / √O, a frequency-weighted confidence that, like G²,
 *     rewards common collocates; the conventional companion to PMI.
 *
 * Collocates are grouped at one of three levels (the `mode`), exactly as
 * keyness groups its terms: the citation-form LEMMA (default), the inflection
 * FORM bucket, or the SURFACE spelling as written. No stop-word list is
 * applied — t-score and G² naturally surface function-word collocates while
 * PMI surfaces the lexical ones, which is the point of reporting all three.
 *
 * Counting is over the edited reading text only: the ordered token stream
 * exists for that version alone (the original text lives in the postings
 * overlay), so collocations are an edited-text measure.
 */

import type { ServeArtefacts } from "../artefacts.ts";
import { grouping, type KeyMode } from "./keywords.ts";

export type { KeyMode };

export type CollocationOptions = {
  /** Collocate grouping level (default "lemma"). */
  mode: KeyMode;
  /** Half-width of the context window, in tokens (so the span is ±window). */
  window: number;
  /** Minimum co-occurrence count for a collocate to be scored (noise floor). */
  minCount: number;
  /** Maximum rows to return, after ranking by log-likelihood. */
  limit: number;
};

export type CollocationRow = {
  /** The lemma, form bucket, or surface form (per `mode`). */
  term: string;
  /** Times the collocate falls within the node's window (the co-occurrence). */
  cooccurrence: number;
  /** The collocate's total occurrences in the scoped subcorpus. */
  total: number;
  /** Pointwise mutual information (log₂ observed/expected): the effect size. */
  pmi: number;
  /** Dunning's log-likelihood (G²): the significance of the association. */
  logLikelihood: number;
  /** t-score ((O−E)/√O): frequency-weighted confidence. */
  tScore: number;
};

export type CollocationResult = {
  /** Total tokens in the scoped subcorpus (the rate denominator, N). */
  scopeTokens: number;
  /** Occurrences of the node word in scope. */
  nodeCount: number;
  /** Context positions examined across all node windows (R1). */
  windowTokens: number;
  /** Collocates, ranked by log-likelihood descending. */
  rows: CollocationRow[];
};

/** Per-unit scope flag: 1 = in scope, 0 = out (parallels keyness's partition). */
export const IN_SCOPE = 1;

const LOG2 = Math.log(2);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A 2×2 cell's contribution to G²: 0 when the cell is empty. */
const llCell = (observed: number, expected: number): number =>
  observed === 0 ? 0 : observed * Math.log(observed / expected);

/**
 * Score the collocates of a node word. Pure over the artefacts: the serve layer
 * resolves the node to its surface ids, builds the unit `scope`, and reads the
 * node units' ordered surface streams from tokens.bin, passing them in
 * `nodeUnits` (unit index -> the unit's surface-id stream). Marginal frequencies
 * (every collocate's total, and N) come from the inverted index over the same
 * scope, so the rates are consistent with the search/keyness counts.
 */
export const collocations = (
  artefacts: ServeArtefacts,
  scope: Int8Array,
  nodeSurfaces: Set<number>,
  nodeUnits: Map<number, Uint32Array>,
  options: CollocationOptions,
): CollocationResult => {
  const { units, postings } = artefacts;

  let scopeTokens = 0;
  for (let unit = 0; unit < scope.length; unit++) {
    if (scope[unit] === IN_SCOPE) scopeTokens += units.tokenCount[unit];
  }
  if (scopeTokens === 0 || nodeSurfaces.size === 0 || nodeUnits.size === 0) {
    return { scopeTokens, nodeCount: 0, windowTokens: 0, rows: [] };
  }

  const { groupOf, labels } = grouping(artefacts, options.mode);
  // The node's own groups are never reported as collocates of themselves.
  const nodeGroups = new Set<number>();
  for (const id of nodeSurfaces) nodeGroups.add(groupOf[id]);

  // Marginal frequency of every group in scope (C1, and via the sum, N's
  // breakdown), from the inverted index — the same pass keyness counts over.
  const total = new Float64Array(labels.length);
  for (let id = 0; id < groupOf.length; id++) {
    const group = groupOf[id];
    for (
      let i = postings.offsets[id] * 2;
      i < postings.offsets[id + 1] * 2;
      i += 2
    ) {
      if (scope[postings.pairs[i]] === IN_SCOPE) total[group]++;
    }
  }

  // Walk each node unit's token stream, collecting the distinct context
  // positions around every node occurrence (windows clamped to the unit,
  // overlaps de-duplicated), and tally their groups (O11) and total (R1).
  const cooccurrence = new Float64Array(labels.length);
  let nodeCount = 0;
  let windowTokens = 0;
  const window = options.window;
  for (const surfaces of nodeUnits.values()) {
    const len = surfaces.length;
    const nodeAt = new Uint8Array(len); // node positions, to exclude as context
    const positions: number[] = [];
    for (let p = 0; p < len; p++) {
      if (nodeSurfaces.has(surfaces[p])) {
        nodeAt[p] = 1;
        positions.push(p);
      }
    }
    if (positions.length === 0) continue;
    nodeCount += positions.length;
    const context = new Uint8Array(len); // a position counted at most once
    for (const p of positions) {
      const lo = Math.max(0, p - window);
      const hi = Math.min(len - 1, p + window);
      for (let k = lo; k <= hi; k++) {
        if (nodeAt[k] === 1 || context[k] === 1) continue;
        context[k] = 1;
        cooccurrence[groupOf[surfaces[k]]]++;
        windowTokens++;
      }
    }
  }

  const n = scopeTokens;
  const r1 = windowTokens;
  const rows: CollocationRow[] = [];
  for (let group = 0; group < labels.length; group++) {
    const o11 = cooccurrence[group];
    if (o11 < options.minCount || nodeGroups.has(group)) continue;
    const c1 = total[group];
    const e11 = (r1 * c1) / n;

    // 2×2 contingency table (collocate in/out of the node window × in/out of
    // the scope): all four cells are non-negative because each context
    // position is counted once, so O11 ≤ C1 and O11 ≤ R1.
    const o12 = r1 - o11;
    const o21 = c1 - o11;
    const o22 = n - r1 - o21;
    const e12 = (r1 * (n - c1)) / n;
    const e21 = ((n - r1) * c1) / n;
    const e22 = ((n - r1) * (n - c1)) / n;
    const logLikelihood = 2 *
      (llCell(o11, e11) + llCell(o12, e12) +
        llCell(o21, e21) + llCell(o22, e22));

    rows.push({
      term: labels[group],
      cooccurrence: o11,
      total: c1,
      pmi: round2(Math.log(o11 / e11) / LOG2),
      logLikelihood: round2(logLikelihood),
      tScore: round2((o11 - e11) / Math.sqrt(o11)),
    });
  }

  rows.sort((x, y) =>
    y.logLikelihood - x.logLikelihood ||
    y.cooccurrence - x.cooccurrence ||
    (x.term < y.term ? -1 : x.term > y.term ? 1 : 0)
  );
  return {
    scopeTokens,
    nodeCount,
    windowTokens,
    rows: rows.slice(0, options.limit),
  };
};
