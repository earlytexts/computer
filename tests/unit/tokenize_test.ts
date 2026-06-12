import { assertEquals } from "@std/assert";
import {
  normalizeSurface,
  surfaceForm,
  tokenize,
} from "../../src/lib/tokenize.ts";

Deno.test("tokenize case-folds but keeps spellings and offsets", () => {
  const spans = tokenize("The Encrease of LIBERTY.");
  assertEquals(
    spans.map((s) => s.surface),
    ["the", "encrease", "of", "liberty"],
  );
  assertEquals(spans[1].start, 4);
  assertEquals(spans[1].end, 12);
});

Deno.test("tokenize keeps internal hyphens and apostrophes", () => {
  assertEquals(
    tokenize("school-men don't, ’tis said --so--").map((s) => s.surface),
    ["school-men", "don't", "’tis", "said", "so"],
  );
  // edge hyphens are trimmed and the offsets tightened
  const [span] = tokenize("--so--").slice(-1);
  assertEquals(span.start, 2);
  assertEquals(span.end, 4);
});

Deno.test("surfaceForm folds a query word like corpus text", () => {
  assertEquals(surfaceForm("Tho'"), "tho'");
  assertEquals(surfaceForm("LIBERTY"), "liberty");
  assertEquals(surfaceForm("--caus--"), "caus");
  assertEquals(surfaceForm("..."), "");
});

Deno.test("normalizeSurface strips apostrophes and accents", () => {
  assertEquals(normalizeSurface("tho'"), "though"); // variant mapping too
  assertEquals(normalizeSurface("’tis"), "tis");
  assertEquals(normalizeSurface("pluralité"), "pluralite");
});

Deno.test("normalizeSurface expands ligatures", () => {
  assertEquals(normalizeSurface("phænomenon"), "phenomenon"); // via variants
  assertEquals(normalizeSurface("œconomy"), "economy");
});

Deno.test("normalizeSurface applies the variant-spelling table", () => {
  assertEquals(normalizeSurface("encrease"), "increase");
  assertEquals(normalizeSurface("betwixt"), "between");
  assertEquals(normalizeSurface("shew"), "show");
});
