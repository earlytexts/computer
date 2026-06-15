import { assert, assertEquals } from "@std/assert";
import {
  formKey,
  normalizeSpelling,
  stem,
  surfaceForm,
  tokenize,
} from "../../src/lib/tokenize.ts";

/** Two surfaces share a canonical spelling (united by spelling-tolerant search). */
const sameSpelling = (a: string, b: string): boolean =>
  normalizeSpelling(a) === normalizeSpelling(b);

/** Two surfaces share a form bucket (united by the tolerant form search). */
const sameForm = (a: string, b: string): boolean =>
  formKey(normalizeSpelling(a)) === formKey(normalizeSpelling(b));

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

Deno.test("normalizeSpelling canonicalises orthography to a real word", () => {
  // accents, ligatures, apostrophes folded
  assert(sameSpelling("’tis", "tis"));
  assert(sameSpelling("pluralité", "pluralite"));
  assert(sameSpelling("œconomy", "economy")); // ligature, then via variants
  assert(sameSpelling("phænomenon", "phenomenon"));
  // old spelling mapped to modern, via the variant table
  assert(sameSpelling("encrease", "increase"));
  assert(sameSpelling("betwixt", "between"));
  assert(sameSpelling("shew", "show"));
  // productive folds: -ise canonicalises to -ize, -our to -or
  assertEquals(normalizeSpelling("organise"), "organize");
  assertEquals(normalizeSpelling("honour"), "honor");
  // but the output is a real word, NOT a stem: inflection is preserved
  assertEquals(normalizeSpelling("encreasing"), "increasing");
  assert(!sameSpelling("increase", "increases")); // spelling keeps the form
});

Deno.test("the productive folds leave short look-alikes alone", () => {
  assertEquals(normalizeSpelling("rise"), "rise");
  assertEquals(normalizeSpelling("wise"), "wise");
  assertEquals(normalizeSpelling("four"), "four");
  assertEquals(normalizeSpelling("flour"), "flour");
});

Deno.test("formKey collapses inflections over the canonical spelling", () => {
  // the form key is just a bucket, but these anchor the behaviour
  assertEquals(stem("causes"), stem("cause"));
  assert(sameForm("cause", "causes"));
  assert(sameForm("connexion", "connections")); // variant spelling + plural
  assert(sameForm("encrease", "increases")); // old spelling + plural
  // distinct words stay distinct
  assert(!sameForm("cause", "effect"));
  assert(!sameForm("liberty", "liberality"));
});
