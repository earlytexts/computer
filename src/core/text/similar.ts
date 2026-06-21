/**
 * Similarity over the document-term matrix (item 3 of the roadmap): given a
 * target document, the corpus items whose lexical content most resembles it.
 *
 * Where keyness (keywords.ts) compares a subcorpus's word *rates* against a
 * reference and collocation (collocations.ts) compares a word's *company*
 * against chance, similarity compares whole *vectors*: each (edition, section)
 * document is a point in lemma space (its TF-IDF row in the DTM, already
 * L2-normalised at build time), and two documents are similar when their vectors
 * point the same way — the cosine of the angle between them, which for unit
 * vectors is just their dot product.
 *
 * Coarser items (a whole edition, a whole work) are the sum of their constituent
 * document rows, re-normalised here: summing first and normalising once treats
 * the item as a single bag of words, so a long work and a short one are compared
 * by what they say, not how much. The TF-IDF weights are strictly positive (see
 * buildDtm), so a non-zero dot product means genuine shared vocabulary; items
 * with no overlap (cosine 0) are dropped rather than reported as a tie at the
 * bottom.
 *
 * Pure over the DTM: the serve layer resolves the request to the target's
 * document rows and partitions the rest of the corpus into the candidate items
 * (`groupDocs`, one entry per result item, each a list of its document rows),
 * then reads back the ranked rows. The vectors never leave the server — only an
 * opaque score does, the same opacity as the search score.
 */

import type { Dtm } from "../artefacts.ts";

export type SimilarOptions = {
  /** Maximum rows to return, after ranking by similarity. */
  limit: number;
};

export type SimilarRow = {
  /** Index into the serve layer's parallel `groupDocs`/labels arrays. */
  group: number;
  /** Cosine similarity to the target (0–1), rounded; opaque on the wire. */
  score: number;
};

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Rank the candidate items by cosine similarity to the target. The target's
 * aggregate vector is the (re-normalised) sum of `targetDocs`' DTM rows; each
 * candidate group's vector is built the same way and dotted against it. A dense
 * scratch buffer accumulates one group's vector at a time, cleared by walking
 * only the columns it touched, so the whole pass is O(total non-zeros) in time
 * and O(lemmas) in space regardless of how many groups there are.
 */
export const similar = (
  dtm: Dtm,
  targetDocs: number[],
  groupDocs: number[][],
  options: SimilarOptions,
): SimilarRow[] => {
  const { rowPtr, cols, vals, lemmas } = dtm;
  const nLemmas = lemmas.length;

  // The target's aggregate vector and its norm. An empty target (no rows, or
  // rows of only out-of-vocabulary blocks) admits no comparison.
  const target = new Float64Array(nLemmas);
  for (const d of targetDocs) {
    for (let i = rowPtr[d]; i < rowPtr[d + 1]; i++) target[cols[i]] += vals[i];
  }
  let targetNorm = 0;
  for (let c = 0; c < nLemmas; c++) targetNorm += target[c] * target[c];
  if (targetNorm === 0) return [];
  const targetInv = 1 / Math.sqrt(targetNorm);

  const scratch = new Float64Array(nLemmas);
  const rows: SimilarRow[] = [];
  for (let g = 0; g < groupDocs.length; g++) {
    const docs = groupDocs[g];
    // Accumulate the group's summed vector into scratch, tracking the columns
    // touched so it can be zeroed again without scanning all of `scratch`. A
    // TF-IDF weight is strictly positive, so a zero entry is reliably untouched.
    const touched: number[] = [];
    for (const d of docs) {
      for (let i = rowPtr[d]; i < rowPtr[d + 1]; i++) {
        const c = cols[i];
        if (scratch[c] === 0) touched.push(c);
        scratch[c] += vals[i];
      }
    }
    let dot = 0;
    let norm = 0;
    for (const c of touched) {
      dot += target[c] * scratch[c];
      norm += scratch[c] * scratch[c];
      scratch[c] = 0; // reset for the next group
    }
    if (norm === 0 || dot === 0) continue; // no shared vocabulary
    rows.push({ group: g, score: round4((dot * targetInv) / Math.sqrt(norm)) });
  }

  rows.sort((x, y) => y.score - x.score || x.group - y.group);
  return rows.slice(0, options.limit);
};
