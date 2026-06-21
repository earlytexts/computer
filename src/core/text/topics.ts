/**
 * Reading the topic model (item 4 of the roadmap): the pure aggregation the
 * topic routes share. The model itself is trained at build time (buildTopics, an
 * NMF over the DTM) and read back as a `Topics` artefact — per-topic term
 * distributions and a per-document mix over topics. Everything the serve side
 * does with it reduces to one operation: take a set of documents (a section, an
 * edition's sections, a work's, the whole corpus) and ask what its topic mix is.
 *
 * `aggregateMix` is that operation. Each stored document row is already a mix
 * (its weights sum to 1), so summing the rows of an item and re-normalising once
 * treats the item as a single bag of sections — a long work and a short one are
 * compared by their proportions, not their length, the same way `similar` sums
 * and re-normalises its vectors. It powers both faces of the model: a target's
 * mix ("what this work is about") and, applied per work, a topic's prominence
 * across the corpus ("trace this topic across authors and decades").
 */

import type { Topics } from "../artefacts.ts";

/**
 * The aggregate topic mix of a set of DTM documents: the sum of their mix rows,
 * re-normalised to a proportion over the K topics. Documents with no indexed
 * text contribute a zero row, so an item of only empty documents yields an
 * all-zero mix (the caller reads that as "nothing to report").
 */
export const aggregateMix = (topics: Topics, docs: number[]): Float64Array => {
  const { k, mix } = topics;
  const out = new Float64Array(k);
  for (const d of docs) {
    const row = d * k;
    for (let t = 0; t < k; t++) out[t] += mix[row + t];
  }
  let sum = 0;
  for (let t = 0; t < k; t++) sum += out[t];
  if (sum === 0) return out;
  for (let t = 0; t < k; t++) out[t] /= sum;
  return out;
};
