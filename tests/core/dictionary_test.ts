/**
 * The corpus dictionary's effect on the read side: the register drives the
 * spelling/form search levels and the narrow (`resolved`) net, contractions
 * expand into their words, ambiguity is honoured per occurrence, and exempt
 * tokens (names) never normalise. Uses a bespoke corpus (dictionaryCorpus)
 * whose register exercises every reading shape.
 */

import { assert, assertEquals } from "@std/assert";
import { openTestComputer } from "../helpers.ts";
import { dictionaryCorpus } from "../corpus.ts";
import { renderSearch } from "../../src/render.ts";

const open = () => openTestComputer(dictionaryCorpus());

Deno.test("wide spelling search reaches every reading; narrow honours context", async () => {
  const { computer } = await open();

  // "human" at the spelling level. Wide (default) matches any occurrence whose
  // surface could read as human: the title "THE HUMANE ESSAY", the marked
  // `[w:humane=human]` and the exempt `[p:Humane]` in block 1, and the bare
  // "humane" in block 2 — three blocks.
  const wide = await computer.search({ q: "human", match: "spelling" });
  assertEquals(wide.total, 3);
  assertEquals(wide.resolved, false);

  // Narrow matches only the occurrence that actually resolved to human — the
  // `[w:]`-marked one. The title and bare "humane" keep their default reading
  // and the name is exempt, so all drop: one block.
  const narrow = await computer.search({
    q: "human",
    match: "spelling",
    resolved: true,
  });
  assertEquals(narrow.total, 1);
  assertEquals(narrow.resolved, true);
});

Deno.test("a contraction is found by each of its words", async () => {
  const { computer } = await open();
  // "'tis" expands to "it is"; a search for "is" finds the block it sits in.
  const is = await computer.search({ q: "is", match: "spelling" });
  assertEquals(is.total, 1);
});

Deno.test("lemma ambiguity: wide finds the variant, narrow needs the marking", async () => {
  const { computer } = await open();
  // "lay" carries lemmas lay and lie. Wide form search for "lie" reaches it...
  const wide = await computer.search({ q: "lie", match: "form" });
  assertEquals(wide.total, 1);
  // ...but no occurrence resolved to lie (none is marked), so narrow finds none.
  const narrow = await computer.search({
    q: "lie",
    match: "form",
    resolved: true,
  });
  assertEquals(narrow.total, 0);
});

Deno.test("the narrow flag shows in the text rendering", async () => {
  const { computer } = await open();
  const response = await computer.search({
    q: "human",
    match: "spelling",
    resolved: true,
  });
  assert(renderSearch(response).includes("resolved"));
});

Deno.test("a section compare diffs a block carrying [w:] markup", async () => {
  const { computer } = await open();
  // Section 1's block 1 (with the `[w:]` element) differs between the editions,
  // so the word-level diff walks its markup.
  const compared = await computer.compareSection("amb", "amb", "1700", "1710", [
    "1",
  ]);
  assert(compared !== undefined);
});
