/**
 * Query segmentation (src/core/text/search.ts's parseQuery) and the fused
 * multi-word pipeline end to end. Word identity is markit's — the same
 * `wordPattern` that tokenizes the corpus — so a query segments exactly as the
 * texts do; on top of that, a whitespace-separated run of query words whose
 * space-joined fold is a printed multi-word surface (a `~`-fused unit) becomes
 * one query word, so the phrase form of a fused unit matches its single token.
 */

import { assert, assertEquals } from "@std/assert";
import { parseQuery } from "../../src/core/text/mod.ts";
import { testComputer, testData } from "../helpers.ts";

const surfaces = async (q: string): Promise<string[]> => {
  const { artefacts } = await testData();
  return parseQuery(artefacts, q).map((word) => word.surface);
};

Deno.test("parseQuery segments with markit's word alphabet and folds", async () => {
  assertEquals(await surfaces("The school-men, tho' - wrote i.e. so"), [
    "the",
    "school",
    "men",
    "tho'",
    "wrote",
    "i.e",
    "so",
  ]);
  assertEquals(await surfaces("… '' — !"), []); // no word characters
});

Deno.test("parseQuery fuses a run matching a printed multi-word surface", async () => {
  // "a priori" is registered and `~`-fused in the fixture; "ipso facto" is
  // fused but unregistered — both are printed surfaces, so both fuse.
  assertEquals(await surfaces("we reason a priori still"), [
    "we",
    "reason",
    "a priori",
    "still",
  ]);
  assertEquals(await surfaces("ipso facto"), ["ipso facto"]);
  // A pasted U+00A0 (extracted text's own non-breaking space) joins like `~`.
  assertEquals(await surfaces("a\u00A0priori"), ["a priori"]);
  // Punctuation between the words blocks the fuse; so does another word.
  assertEquals(await surfaces("a, priori"), ["a", "priori"]);
  // A pair the corpus never prints fused stays word-by-word.
  assertEquals(await surfaces("causes effects"), ["causes", "effects"]);
});

Deno.test("the capitalisation bit of a fused word is its first word's", async () => {
  const { artefacts } = await testData();
  const words = parseQuery(artefacts, "A priori");
  assertEquals(words, [{ surface: "a priori", capital: true }]);
});

Deno.test("the phrase and single-word forms of a fused unit both find it", async () => {
  const computer = await testComputer();
  // The fused units live in the non-canonical 1750 edition of tw.
  const all = { editions: "all" } as const;
  const phrase = await computer.search({ q: "a priori", ...all });
  assertEquals(phrase.total, 1);
  // The single-word half reaches the fused surface through the reading
  // buckets: a registered unit via its entry's identity words, an
  // unregistered one ("facto") via per-word identity readings.
  assertEquals((await computer.search({ q: "priori", ...all })).total, 1);
  assertEquals((await computer.search({ q: "facto", ...all })).total, 1);
  // The highlight covers the whole fused unit (both words marked).
  const marked = JSON.stringify(phrase.results[0].block);
  assert(marked.includes('"highlight"'));
  assert(/highlight.*priori/.test(marked));
});

Deno.test("the narrow (resolved) net compares a fused unit's whole reading", async () => {
  const computer = await testComputer();
  const narrow = { editions: "all", resolved: true } as const;
  // A registered unit resolves through its entry's reading; an unregistered
  // one ("ipso facto") through its per-word identity reading — both compared
  // as whole strings, never word by word.
  assertEquals((await computer.search({ q: "a priori", ...narrow })).total, 1);
  assertEquals(
    (await computer.search({ q: "ipso facto", ...narrow })).total,
    1,
  );
  // The spelling level takes the same whole-string route.
  assertEquals(
    (await computer.search({ q: "a priori", ...narrow, match: "spelling" }))
      .total,
    1,
  );
});
