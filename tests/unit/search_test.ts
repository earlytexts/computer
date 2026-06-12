import { assert, assertEquals } from "@std/assert";
import {
  makeSnippet,
  normalizeToken,
  parseQuery,
  search,
} from "../../src/lib/search.ts";
import { testData } from "../helpers.ts";

Deno.test("normalizeToken lowercases and strips apostrophes", () => {
  assertEquals(normalizeToken("Tho'"), "though"); // variant mapping too
  assertEquals(normalizeToken("’Tis"), "tis");
  assertEquals(normalizeToken("LIBERTY"), "liberty");
});

Deno.test("normalizeToken expands ligatures and strips accents", () => {
  assertEquals(normalizeToken("phænomenon"), "phenomenon"); // via variants
  assertEquals(normalizeToken("œconomy"), "economy");
  assertEquals(normalizeToken("Pluralité"), "pluralite");
});

Deno.test("normalizeToken applies the variant-spelling table", () => {
  assertEquals(normalizeToken("encrease"), "increase");
  assertEquals(normalizeToken("betwixt"), "between");
  assertEquals(normalizeToken("shew"), "show");
});

Deno.test("parseQuery separates phrases, prefixes, and terms", () => {
  const query = parseQuery(`cause "abstruse philosophy" liber*`);
  assertEquals(query.terms, ["cause"]);
  assertEquals(query.prefixes, ["liber"]);
  assertEquals(query.phrases, [["abstruse", "philosophy"]]);
});

Deno.test("phrase search finds exact sequences", async () => {
  const { searchIndex } = await testData();
  const hits = search(searchIndex, parseQuery(`"liberty of the press"`));
  assert(hits.length > 0);
  assert(hits.every((hit) => /liberty of the press/i.test(hit.unit.text)));
  // and the phrase must be required: a scrambled phrase finds nothing
  const none = search(searchIndex, parseQuery(`"press the of liberty"`));
  assertEquals(none.length, 0);
});

Deno.test("terms are ANDed across a paragraph", async () => {
  const { searchIndex } = await testData();
  const both = search(searchIndex, parseQuery("agreeable sensation"));
  assert(both.length > 0);
  for (const hit of both) {
    const text = hit.unit.text.toLowerCase();
    assert(text.includes("agreeable") && text.includes("sensation"));
  }
  // terms in different paragraphs must not match
  const none = search(searchIndex, parseQuery("agreeable avarice"));
  assertEquals(none.length, 0);
});

Deno.test("prefix queries expand", async () => {
  const { searchIndex } = await testData();
  const exact = search(searchIndex, parseQuery("passion"));
  const prefixed = search(searchIndex, parseQuery("passio*"));
  assert(prefixed.length >= exact.length);
  assert(prefixed.length > 0);
});

Deno.test("old spellings match modern ones both ways", async () => {
  const { searchIndex } = await testData();
  const old = search(searchIndex, parseQuery("encrease"), { work: "tw" });
  const modern = search(searchIndex, parseQuery("increase"), { work: "tw" });
  assertEquals(old.length, modern.length);
  // every tw edition has the sentence, in one spelling or the other
  assertEquals(old.length, 3);
});

Deno.test("filters restrict results to an author, work, and edition", async () => {
  const { searchIndex } = await testData();
  const hits = search(searchIndex, parseQuery("sensation"), {
    author: "test",
    work: "tw",
    edition: "1750",
  });
  assert(hits.length > 0);
  assert(
    hits.every((hit) =>
      hit.unit.author === "test" && hit.unit.work === "tw" &&
      hit.unit.edition === "1750"
    ),
  );
  const none = search(searchIndex, parseQuery("sensation"), {
    author: "other",
  });
  assertEquals(none.length, 0);
});

Deno.test("borrowed documents are indexed under their own work only", async () => {
  const { searchIndex } = await testData();
  // "avarice" appears only in tw/1750, which comp borrows
  const hits = search(searchIndex, parseQuery("avarice"));
  assert(hits.length > 0);
  assert(hits.every((hit) => hit.unit.work === "tw"));
  // comp's own inline essay is indexed under comp
  const inline = search(searchIndex, parseQuery("composite collection alone"));
  assert(inline.length > 0);
  assert(inline.every((hit) => hit.unit.work === "comp"));
});

Deno.test("snippets mark the matched tokens", async () => {
  const { searchIndex } = await testData();
  const hits = search(searchIndex, parseQuery("liberty"));
  assert(hits.length > 0);
  const snippet = makeSnippet(hits[0]);
  assert(snippet.some((part) => part.marked));
});
