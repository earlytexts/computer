/**
 * computer.keywords — keyness: the words a target subcorpus uses more than the
 * rest of the corpus, scored by log-likelihood (G²) and a log-ratio effect size.
 */

import { assert, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";

Deno.test("surfaces a target work's distinctive vocabulary", async () => {
  const computer = await testComputer();
  // The canonical Test Work (1760) is the only canonical edition with "liberty"
  // (its Section 2); the rest of test's canonical editions never use it.
  const response = await computer.keywords({
    author: "test",
    work: "tw",
    min: 1,
  });
  assertEquals(response.by, "lemma");
  assertEquals(response.version, "edited");
  assertEquals(response.author, "test");
  assertEquals(response.work, "tw");
  assert(response.targetTokens > 0);
  assert(response.referenceTokens > 0);
  assertEquals(response.total, response.results.length);

  const liberty = response.results.find((r) => r.term === "liberty");
  assert(liberty !== undefined, "expected 'liberty' among the keywords");
  assert(liberty.target >= 2);
  assertEquals(liberty.reference, 0);
  // Over-represented terms only, ranked by log-likelihood descending.
  for (const r of response.results) assert(r.logRatio > 0);
  for (let i = 1; i < response.results.length; i++) {
    assert(
      response.results[i - 1].logLikelihood >=
        response.results[i].logLikelihood,
    );
  }
});

Deno.test("the reference excludes the target (a term in both is not unique)", async () => {
  const computer = await testComputer();
  const response = await computer.keywords({
    author: "test",
    work: "tw",
    min: 1,
  });
  // "second paragraph, identical in every edition" sits in tw; "philosophy"
  // belongs to the Solitary Treatise (the reference) — it must never appear as a
  // keyword of tw, and any returned term must out-rate the reference.
  assert(response.results.every((r) => r.term !== "philosophy"));
  for (const r of response.results) {
    const targetRate = r.target / response.targetTokens;
    const refRate = r.reference / response.referenceTokens;
    assert(targetRate > refRate);
  }
});

Deno.test("the min threshold filters out rare terms", async () => {
  const computer = await testComputer();
  const low = await computer.keywords({ author: "test", work: "tw", min: 1 });
  const high = await computer.keywords({ author: "test", work: "tw", min: 2 });
  assert(high.results.length <= low.results.length);
  for (const r of high.results) assert(r.target >= 2);
});

Deno.test("by=surface keeps spellings apart that lemma unites", async () => {
  const computer = await testComputer();
  const bySurface = await computer.keywords({
    author: "test",
    work: "tw",
    by: "surface",
    min: 1,
  });
  assertEquals(bySurface.by, "surface");
  // Surfaces are the spellings as written, so every term is lower-case and
  // single-token (no citation-form rewriting).
  for (const r of bySurface.results) {
    assertEquals(r.term, r.term.toLowerCase());
    assert(!r.term.includes(" "));
  }
});

Deno.test("no target (no author or work) yields no keywords", async () => {
  const computer = await testComputer();
  const response = await computer.keywords({});
  assertEquals(response.total, 0);
  assertEquals(response.results.length, 0);
  assertEquals(response.targetTokens, 0);
  assertEquals(response.referenceTokens, 0);
});

Deno.test("relative rates are per 1000 tokens, to one decimal", async () => {
  const computer = await testComputer();
  const response = await computer.keywords({
    author: "test",
    work: "tw",
    min: 1,
  });
  for (const r of response.results) {
    assertEquals(
      r.targetRelative,
      Math.round((r.target / response.targetTokens) * 1000 * 10) / 10,
    );
    assertEquals(
      r.referenceRelative,
      Math.round((r.reference / response.referenceTokens) * 1000 * 10) / 10,
    );
  }
});
