/**
 * computer.collocations — positional co-occurrence: the words that occur near a
 * node word more than chance, scored by log-likelihood (G²), PMI, and t-score.
 */

import { assert, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";

Deno.test("surfaces the words that cluster around a node word", async () => {
  const computer = await testComputer();
  // In the canonical Test Work (1760), Section 2: "The liberty of the press…"
  // and "…the natural liberty of thinking…" — "liberty" is followed by "of"
  // both times and stands among "press", "natural", "thinking".
  const response = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "tw",
    min: 1,
  });
  assertEquals(response.q, "liberty");
  assertEquals(response.by, "lemma");
  assertEquals(response.match, "form");
  assertEquals(response.window, 5);
  assertEquals(response.author, "test");
  assertEquals(response.work, "tw");
  assert(response.scopeTokens > 0);
  assert(response.nodeCount >= 2, "expected liberty at least twice");
  assert(response.windowTokens > 0);
  assertEquals(response.total, response.results.length);

  const of = response.results.find((r) => r.term === "of");
  assert(of !== undefined, "expected 'of' among liberty's collocates");
  assert(of.cooccurrence >= 2);

  // The node word is never reported as its own collocate.
  assert(response.results.every((r) => r.term !== "liberty"));

  // Ranked by log-likelihood descending.
  for (let i = 1; i < response.results.length; i++) {
    assert(
      response.results[i - 1].logLikelihood >=
        response.results[i].logLikelihood,
    );
  }
});

Deno.test("a node word absent from the scope yields nothing", async () => {
  const computer = await testComputer();
  // "liberty" lives only in tw; the Solitary Treatise never uses it.
  const response = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "solo",
    min: 1,
  });
  assertEquals(response.nodeCount, 0);
  assertEquals(response.total, 0);
  assertEquals(response.results.length, 0);
});

Deno.test("an empty query yields nothing", async () => {
  const computer = await testComputer();
  const response = await computer.collocations({ q: "" });
  assertEquals(response.total, 0);
  assertEquals(response.results.length, 0);
  assertEquals(response.scopeTokens, 0);
});

Deno.test("the min threshold filters out rare collocates", async () => {
  const computer = await testComputer();
  const low = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "tw",
    min: 1,
  });
  const high = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "tw",
    min: 2,
  });
  assert(high.results.length <= low.results.length);
  for (const r of high.results) assert(r.cooccurrence >= 2);
});

Deno.test("a narrower window admits fewer co-occurrence positions", async () => {
  const computer = await testComputer();
  const wide = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "tw",
    min: 1,
    window: 5,
  });
  const narrow = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "tw",
    min: 1,
    window: 1,
  });
  assert(narrow.windowTokens <= wide.windowTokens);
  // The window only bounds context; the node count is the same either way.
  assertEquals(narrow.nodeCount, wide.nodeCount);
});

Deno.test("no collocate's co-occurrence exceeds its total (table stays consistent)", async () => {
  const computer = await testComputer();
  const response = await computer.collocations({
    q: "of",
    editions: "all",
    min: 1,
  });
  for (const r of response.results) {
    assert(
      r.cooccurrence <= r.total,
      `${r.term}: ${r.cooccurrence} > ${r.total}`,
    );
    assert(r.cooccurrence >= 1);
  }
});

Deno.test("by=exact keeps spellings apart that lemma unites", async () => {
  const computer = await testComputer();
  const response = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "tw",
    by: "exact",
    min: 1,
  });
  assertEquals(response.by, "exact");
  for (const r of response.results) {
    assertEquals(r.term, r.term.toLowerCase());
    assert(!r.term.includes(" "));
  }
});

Deno.test("relative rate is per 1000 window tokens, to one decimal", async () => {
  const computer = await testComputer();
  const response = await computer.collocations({
    q: "liberty",
    author: "test",
    work: "tw",
    min: 1,
  });
  for (const r of response.results) {
    assertEquals(
      r.relative,
      Math.round((r.cooccurrence / response.windowTokens) * 1000 * 10) / 10,
    );
  }
});
