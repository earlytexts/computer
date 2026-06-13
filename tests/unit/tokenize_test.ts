import { assert, assertEquals } from "@std/assert";
import {
  normalizeSurface,
  stem,
  surfaceForm,
  tokenize,
} from "../../src/lib/tokenize.ts";

/** Two surfaces share a normalised form (so a tolerant search unites them). */
const unify = (a: string, b: string): boolean =>
  normalizeSurface(a) === normalizeSurface(b);

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

Deno.test("stem collapses plurals and inflections", () => {
  // the normalised form is just a bucket key, but these anchor the behaviour
  assertEquals(stem("causes"), stem("cause"));
  assertEquals(stem("effects"), stem("effect"));
  assertEquals(stem("connection"), "connect");
  assertEquals(stem("increase"), stem("increases"));
});

Deno.test("normalizeSurface folds apostrophes, accents, and ligatures", () => {
  assert(unify("’tis", "tis"));
  assert(unify("pluralité", "pluralite"));
  assert(unify("œconomy", "economy")); // ligature, then via variants
  assert(unify("phænomenon", "phenomenon"));
});

Deno.test("normalizeSurface unites variant spellings and inflections", () => {
  // variant spellings
  assert(unify("encrease", "increase"));
  assert(unify("betwixt", "between"));
  assert(unify("shew", "show"));
  // plurals and inflections, including over a variant spelling
  assert(unify("cause", "causes"));
  assert(unify("connexion", "connections"));
  assert(unify("encrease", "increases"));
  // but distinct words stay distinct
  assert(!unify("cause", "effect"));
  assert(!unify("liberty", "liberality"));
});
