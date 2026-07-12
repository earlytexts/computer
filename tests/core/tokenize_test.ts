/**
 * The computer's tokenizer (src/core/text/tokenize.ts): the surfaces and offsets
 * the index and search share. Word identity is the corpus's — the imported
 * `wordPattern` and `fold` — so this layer only adds character offsets and the
 * register-driven multi-word join (`joinTokens`), the same `joinMultiWord` the
 * corpus runs for accounting.
 */

import { assertEquals } from "@std/assert";
import { fold } from "@earlytexts/corpus/wire";
import {
  joinTokens,
  multiWordKeys,
  tokenize,
} from "../../src/core/text/tokenize.ts";

const surfaces = (text: string): string[] =>
  tokenize(text).map((span) => span.surface);

Deno.test("tokenize keeps apostrophes and splits hyphens (the corpus alphabet)", () => {
  assertEquals(surfaces("The school-men, tho' - a lone dash - wrote."), [
    "the",
    "school",
    "men",
    "tho'",
    "a",
    "lone",
    "dash",
    "wrote",
  ]);
});

Deno.test("an internal period joins only before a letter", () => {
  // `i.e` joins; a trailing period drops; a period before a digit splits.
  assertEquals(surfaces("i.e. and e.g things, end.The end. The 3.14"), [
    "i.e",
    "and",
    "e.g",
    "things",
    "end.the",
    "end",
    "the",
    "3",
    "14",
  ]);
});

Deno.test("a non-breaking space is ordinary whitespace — no join in the base tokens", () => {
  // Extraction now emits a plain space for an nbSpace, so segmentation is
  // single-word; the join is a separate, register-driven pass.
  assertEquals(surfaces("reasoning a priori until to morrow"), [
    "reasoning",
    "a",
    "priori",
    "until",
    "to",
    "morrow",
  ]);
});

Deno.test("multiWordKeys are the surfaces with an internal space", () => {
  assertEquals(
    multiWordKeys(["a priori", "to morrow", "priori", "the"]),
    new Set(["a priori", "to morrow"]),
  );
});

Deno.test("joinTokens fuses registered units over the space adjacency", () => {
  const text = "reasoning a priori, and to morrow soon";
  const keys = multiWordKeys(["a priori", "to morrow"]);
  const spans = joinTokens(tokenize(text), text, keys);
  assertEquals(spans.map((span) => span.surface), [
    "reasoning",
    "a priori",
    "and",
    "to morrow",
    "soon",
  ]);
  // The fused span covers the whole printed unit, for highlighting.
  const priori = spans[1];
  assertEquals(text.slice(priori.start, priori.end), "a priori");
});

Deno.test("joinTokens does not fuse across punctuation or a line break", () => {
  const text = "a, priori\na priori";
  const spans = joinTokens(tokenize(text), text, multiWordKeys(["a priori"]));
  // Only the second pair — separated by a plain space — fuses.
  assertEquals(spans.map((span) => span.surface), ["a", "priori", "a priori"]);
});

Deno.test("joinTokens with no keys returns the base tokens", () => {
  const text = "a priori";
  assertEquals(
    joinTokens(tokenize(text), text, new Set()).map((span) => span.surface),
    ["a", "priori"],
  );
});

// The read side keys the register by the tokenizer's surface (readings.ts's
// `dictionary[span.surface]`), while the corpus keys the register by `fold`
// (words.ts). Importing `fold` here rather than reproducing it makes the two
// equal by construction — the pronoun "I", where a plain `.toLowerCase()` used
// to diverge (folding it would collide with the numeral "i"), included.
Deno.test("tokenizer folding is the corpus register's fold()", () => {
  for (const token of ["The", "tho'", "HUMANE", "MDCC", "i", "I"]) {
    assertEquals(
      tokenize(token)[0]?.surface,
      fold(token),
      `computer surface for ${JSON.stringify(token)} must equal corpus fold()`,
    );
  }
});
