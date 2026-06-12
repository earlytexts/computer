import { assert, assertEquals } from "@std/assert";
import { readUnitBlock } from "../../src/lib/artefacts.ts";
import {
  matchRanges,
  parseQuery,
  search,
  type SearchHit,
} from "../../src/lib/search.ts";
import { blockText, highlightBlock } from "../../src/lib/text.ts";
import { testData, unitText } from "../helpers.ts";

const editionOf = async (hit: SearchHit) => {
  const { artefacts } = await testData();
  return artefacts.manifest.editions[artefacts.units.edition[hit.unitIndex]];
};

Deno.test("parseQuery separates phrases, prefixes, and terms", () => {
  const query = parseQuery(`Cause "Abstruse Philosophy" liber*`);
  assertEquals(query.terms, ["cause"]);
  assertEquals(query.prefixes, ["liber"]);
  assertEquals(query.phrases, [["abstruse", "philosophy"]]);
});

Deno.test("phrase search finds exact sequences", async () => {
  const data = await testData();
  const hits = search(data.artefacts, parseQuery(`"liberty of the press"`));
  assert(hits.length > 0);
  for (const hit of hits) {
    assert(/liberty of the press/i.test(unitText(data, hit.unitIndex)));
  }
  // and the phrase must be required: a scrambled phrase finds nothing
  const none = search(data.artefacts, parseQuery(`"press the of liberty"`));
  assertEquals(none.length, 0);
});

Deno.test("terms are ANDed across a paragraph", async () => {
  const data = await testData();
  const both = search(data.artefacts, parseQuery("agreeable sensation"));
  assert(both.length > 0);
  for (const hit of both) {
    const text = unitText(data, hit.unitIndex).toLowerCase();
    assert(text.includes("agreeable") && text.includes("sensation"));
  }
  // terms in different paragraphs must not match
  const none = search(data.artefacts, parseQuery("agreeable avarice"));
  assertEquals(none.length, 0);
});

Deno.test("prefix queries expand", async () => {
  const { artefacts } = await testData();
  const exact = search(artefacts, parseQuery("passion"));
  const prefixed = search(artefacts, parseQuery("passio*"));
  assert(prefixed.length >= exact.length);
  assert(prefixed.length > 0);
});

Deno.test("normalised search matches old and modern spellings", async () => {
  const { artefacts } = await testData();
  const old = search(artefacts, parseQuery("encrease"), { work: "tw" });
  const modern = search(artefacts, parseQuery("increase"), { work: "tw" });
  assertEquals(old.length, modern.length);
  // every tw edition has the sentence, in one spelling or the other
  assertEquals(old.length, 3);
});

Deno.test("exact search matches spellings as written", async () => {
  const { artefacts } = await testData();
  const old = search(artefacts, parseQuery("encrease"), {}, "exact");
  assertEquals(old.length, 1);
  assertEquals((await editionOf(old[0])).edition, "1750");
  const modern = search(artefacts, parseQuery("increase"), {}, "exact");
  assertEquals(modern.length, 2);
  // case is still folded at the exact layer
  const upper = search(artefacts, parseQuery("ENCREASE"), {}, "exact");
  assertEquals(upper.length, 1);
});

Deno.test("filters restrict results to an author, work, and edition", async () => {
  const { artefacts } = await testData();
  const hits = search(artefacts, parseQuery("sensation"), {
    author: "test",
    work: "tw",
    edition: "1750",
  });
  assert(hits.length > 0);
  for (const hit of hits) {
    const ref = await editionOf(hit);
    assertEquals(
      [ref.author, ref.work, ref.edition],
      ["test", "tw", "1750"],
    );
  }
  const none = search(artefacts, parseQuery("sensation"), {
    author: "other",
  });
  assertEquals(none.length, 0);
});

Deno.test("borrowed documents are indexed under their own work only", async () => {
  const { artefacts } = await testData();
  // "avarice" appears only in tw/1750, which comp borrows
  const hits = search(artefacts, parseQuery("avarice"));
  assert(hits.length > 0);
  for (const hit of hits) assertEquals((await editionOf(hit)).work, "tw");
  // comp's own inline essay is indexed under comp
  const inline = search(artefacts, parseQuery("composite collection alone"));
  assert(inline.length > 0);
  for (const hit of inline) assertEquals((await editionOf(hit)).work, "comp");
});

Deno.test("matchRanges merges consecutive matched tokens", () => {
  const text = "The liberty of the press is a passion.";
  // tokens: the(0) liberty(1) of(2) the(3) press(4) is(5) a(6) passion(7)
  const ranges = matchRanges(text, [1, 2, 3, 4, 7]);
  assertEquals(ranges, [
    { start: 4, end: 24 }, // "liberty of the press"
    { start: 30, end: 37 }, // "passion"
  ]);
});

Deno.test("search hits highlight across formatting boundaries", async () => {
  const data = await testData();
  const hits = search(data.artefacts, parseQuery(`"natural liberty of"`));
  assertEquals(hits.length, 1);
  const block = await readUnitBlock(data.artefacts, hits[0].unitIndex);
  const text = blockText(block);
  assertEquals(
    text,
    "Men of letters defend the natural liberty of thinking in every age.",
  );
  const highlighted = highlightBlock(
    block,
    matchRanges(text, hits[0].positions),
  );
  // "liberty" sits inside an emphasis wrapper; the phrase is marked in
  // three fragments around it, visually contiguous when rendered
  const marks: string[] = [];
  const walk = (elements: unknown[]): void => {
    for (const el of elements as Record<string, unknown>[]) {
      if (el.type === "highlight") {
        const inner = el.content as { content: string }[];
        marks.push(inner.map((n) => n.content).join(""));
      } else if (Array.isArray(el.content)) walk(el.content);
    }
  };
  for (const element of highlighted.content) {
    if ("content" in element && Array.isArray(element.content)) {
      walk(element.content);
    }
  }
  assertEquals(marks, ["natural ", "liberty", " of"]);
});

Deno.test("a token split by a page break is still highlighted", async () => {
  const data = await testData();
  const hits = search(data.artefacts, parseQuery("recorded"));
  assertEquals(hits.length, 1);
  const block = await readUnitBlock(data.artefacts, hits[0].unitIndex);
  const text = blockText(block);
  assert(text.includes("recorded")); // re//42//corded in the source
  const ranges = matchRanges(text, hits[0].positions);
  const highlighted = highlightBlock(block, ranges);
  assertEquals(blockText(highlighted), text);
});
