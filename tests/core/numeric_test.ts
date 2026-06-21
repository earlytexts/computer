/**
 * Numeric regression tests for the statistical discovery routes (TODO item 11).
 *
 * The behavioural suite (keywords_test, collocations_test, similar_test,
 * topics_test) pins the *invariants* of these routes — ordering, ranges,
 * normalisation, scope — but never the actual numbers. A refactor of the maths
 * could silently shift a reported G² or cosine and every invariant test would
 * still pass. Unlike the search `score` (explicitly opaque and non-contractual),
 * these numbers are read and cited by researchers: they are part of the contract.
 *
 * This file is the one thing the seam cannot see — golden-value assertions over
 * the shared in-memory test corpus. The keyness and collocation goldens below are
 * hand-derivable from the corpus token counts (worked through in the comments);
 * the cosine and topic-weight goldens are pinned from the deterministic, seeded
 * pipeline (see the determinism test in topics_test) so any drift in the
 * factorisation or the TF-IDF vectors trips a test rather than slipping out the
 * wire. Tolerances are far tighter than any real regression would move a value,
 * yet absorb sub-rounding float noise.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";

/** Wire values are rounded to 2 dp (G²/PMI/t-score/log-ratio); pin tightly. */
const STAT = 1e-3;
/** Cosine and topic weights are rounded to 4 dp; pin a touch looser. */
const WEIGHT = 5e-4;

/** Find a result row by its `term`, failing loudly if it is absent. */
const byTerm = <T extends { term: string }>(rows: T[], term: string): T => {
  const row = rows.find((r) => r.term === term);
  assert(row !== undefined, `expected a row for "${term}"`);
  return row;
};

Deno.test("keyness G² and log-ratio match their golden values", async () => {
  const computer = await testComputer();
  const response = await computer.keywords({
    author: "test",
    work: "tw",
    min: 1,
  });

  // The partition of the canonical Test Work (target) against the rest of the
  // canonical corpus (reference) is fixed by the fixture.
  assertEquals(response.targetTokens, 63);
  assertEquals(response.referenceTokens, 58);

  // "liberty": target 2, reference 0 (smoothed to 0.5). N = 121.
  //   E_target = 63·2/121 = 1.0413 → G² = 2·[2·ln(2/1.0413)] = 2.61
  //   log₂((2/63)/(0.5/58)) = log₂(3.683) = 1.88
  const liberty = byTerm(response.results, "liberty");
  assertEquals(liberty.target, 2);
  assertEquals(liberty.reference, 0);
  assertAlmostEquals(liberty.logLikelihood, 2.61, STAT);
  assertAlmostEquals(liberty.logRatio, 1.88, STAT);

  // "of": target 6, reference 2 (present on both sides — no smoothing).
  //   E_target = 63·8/121 = 4.1653 → G² = 2·[6·ln(6/4.1653) + 2·ln(2/3.8347)]
  //            = 1.78;  log₂((6/63)/(2/58)) = 1.47
  const of = byTerm(response.results, "of");
  assertEquals(of.target, 6);
  assertEquals(of.reference, 2);
  assertAlmostEquals(of.logLikelihood, 1.78, STAT);
  assertAlmostEquals(of.logRatio, 1.47, STAT);

  // "passion": target 2, reference 1 — a small, barely-significant difference.
  const passion = byTerm(response.results, "passion");
  assertEquals(passion.target, 2);
  assertEquals(passion.reference, 1);
  assertAlmostEquals(passion.logLikelihood, 0.26, STAT);
  assertAlmostEquals(passion.logRatio, 0.88, STAT);

  // "a": target 4, reference 3 — the weakest retained key (lowest G²).
  const a = byTerm(response.results, "a");
  assertEquals(a.target, 4);
  assertEquals(a.reference, 3);
  assertAlmostEquals(a.logLikelihood, 0.07, STAT);
  assertAlmostEquals(a.logRatio, 0.3, STAT);
});

Deno.test("collocation PMI, G² and t-score match their golden values", async () => {
  const computer = await testComputer();
  const response = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "tw",
    min: 1,
  });

  // The node and its window are fixed: two occurrences of "liberty", a ±5
  // window clamped to its block yields N = 63, R₁ = 16 context positions.
  assertEquals(response.scopeTokens, 63);
  assertEquals(response.nodeCount, 2);
  assertEquals(response.windowTokens, 16);

  // "age": O₁₁ = 1, C₁ = 1.  E₁₁ = 16·1/63 = 0.254.
  //   PMI = log₂(1/0.254) = 1.98;  t = (1−0.254)/√1 = 0.75;  G² = 2.79
  const age = byTerm(response.results, "age");
  assertEquals(age.cooccurrence, 1);
  assertEquals(age.total, 1);
  assertAlmostEquals(age.pmi, 1.98, STAT);
  assertAlmostEquals(age.logLikelihood, 2.79, STAT);
  assertAlmostEquals(age.tScore, 0.75, STAT);

  // "of": O₁₁ = 3, C₁ = 6.  E₁₁ = 16·6/63 = 1.5238.
  //   PMI = log₂(3/1.5238) = 0.98;  t = (3−1.5238)/√3 = 0.85;  G² = 1.87
  const of = byTerm(response.results, "of");
  assertEquals(of.cooccurrence, 3);
  assertEquals(of.total, 6);
  assertAlmostEquals(of.pmi, 0.98, STAT);
  assertAlmostEquals(of.logLikelihood, 1.87, STAT);
  assertAlmostEquals(of.tScore, 0.85, STAT);

  // "every": O₁₁ = 1, C₁ = 2 — a less-bound collocate (lower G² and t-score).
  const every = byTerm(response.results, "every");
  assertEquals(every.cooccurrence, 1);
  assertEquals(every.total, 2);
  assertAlmostEquals(every.pmi, 0.98, STAT);
  assertAlmostEquals(every.logLikelihood, 0.58, STAT);
  assertAlmostEquals(every.tScore, 0.49, STAT);

  // "a": O₁₁ = 1, C₁ = 4 — slightly under chance, so PMI and t-score go negative.
  const a = byTerm(response.results, "a");
  assertEquals(a.cooccurrence, 1);
  assertEquals(a.total, 4);
  assertAlmostEquals(a.pmi, -0.02, STAT);
  assertAlmostEquals(a.logLikelihood, 0, STAT);
  assertAlmostEquals(a.tScore, -0.02, STAT);
});

Deno.test("cosine similarity scores match their golden values", async () => {
  const computer = await testComputer();

  // Section 1 of the Test Work against the canonical-edition universe (its own
  // work excluded). The ranked cosines over the TF-IDF vectors are fixed.
  const section = await computer.similar({
    author: "test",
    work: "tw",
    path: ["1"],
  });
  const scoreAt = (author: string, work: string, path: string): number => {
    const row = section.results.find((r) =>
      r.author === author && r.work === work && r.sectionPath.join("/") === path
    );
    assert(row !== undefined, `expected ${author}/${work} section ${path}`);
    return row.score;
  };
  assertAlmostEquals(scoreAt("test", "solo", "1/1"), 0.2184, WEIGHT);
  assertAlmostEquals(scoreAt("test", "solo", "1"), 0.1127, WEIGHT);
  assertAlmostEquals(scoreAt("test", "comp", "in"), 0.0908, WEIGHT);

  // Whole-work similarity (one cosine per other work).
  const work = await computer.similar({
    author: "test",
    work: "tw",
    level: "work",
  });
  const workScore = (slug: string): number => {
    const row = work.results.find((r) => `${r.author}/${r.work}` === slug);
    assert(row !== undefined, `expected work ${slug}`);
    return row.score;
  };
  assertAlmostEquals(workScore("test/solo"), 0.238, WEIGHT);
  assertAlmostEquals(workScore("test/comp"), 0.1401, WEIGHT);
});

Deno.test("topic-term weights match their golden values", async () => {
  const computer = await testComputer();
  const response = await computer.topics({ terms: 5, works: 3 });

  // The seeded NMF is deterministic (see topics_test), so individual topic-term
  // weights are a stable contract. Locate topics by their two-term signature
  // rather than by index, which the factorisation does not guarantee.
  const weightOf = (lemmaA: string, lemmaB: string): [number, number] => {
    const topic = response.topics.find((t) => {
      const lemmas = t.terms.map((term) => term.lemma);
      return lemmas[0] === lemmaA && lemmas[1] === lemmaB;
    });
    assert(topic !== undefined, `expected topic "${lemmaA}, ${lemmaB}"`);
    return [topic.terms[0].weight, topic.terms[1].weight];
  };

  // Two-term topics split their mass cleanly between the pair.
  const [solitary, treatize] = weightOf("solitary", "treatize");
  assertAlmostEquals(solitary, 0.5, WEIGHT);
  assertAlmostEquals(treatize, 0.5, WEIGHT);

  const [part, i] = weightOf("part", "i");
  assertAlmostEquals(part, 0.5686, WEIGHT);
  assertAlmostEquals(i, 0.4314, WEIGHT);

  const [test, work] = weightOf("test", "work");
  assertAlmostEquals(test, 0.5818, WEIGHT);
  assertAlmostEquals(work, 0.4182, WEIGHT);
});

Deno.test("topic-mix weights match their golden values", async () => {
  const computer = await testComputer();
  const mix = await computer.topicMix({
    author: "test",
    work: "tw",
    level: "work",
    limit: 100,
  });

  // The whole work's mix over the topics, by label (the index is not a contract).
  const mixWeight = (label: string): number => {
    const topic = mix.topics.find((t) => t.label === label);
    assert(topic !== undefined, `expected mix topic "${label}"`);
    return topic.weight;
  };
  assertAlmostEquals(mixWeight("test, work"), 0.3326, WEIGHT);
  assertAlmostEquals(mixWeight("of, delicacy, some"), 0.3276, WEIGHT);
  assertAlmostEquals(mixWeight("the, at, to"), 0.1696, WEIGHT);
  assertAlmostEquals(mixWeight("of, liberty, be"), 0.1634, WEIGHT);

  // The mix is a distribution: the shares sum to 1.
  const sum = mix.topics.reduce((n, t) => n + t.weight, 0);
  assertAlmostEquals(sum, 1, 0.01);
});
