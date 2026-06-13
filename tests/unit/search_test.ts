import { assert, assertEquals } from "@std/assert";
import { readUnitBlock } from "../../src/lib/artefacts.ts";
import {
  matchRanges,
  search,
  type SearchHit,
  type SearchOptions,
} from "../../src/lib/search.ts";
import { blockText, highlightBlock } from "../../src/lib/text.ts";
import { testData, unitText } from "../helpers.ts";

const EXACT: SearchOptions = { exactSpelling: true, caseSensitive: false };
const CASED: SearchOptions = { exactSpelling: false, caseSensitive: true };

const editionOf = async (hit: SearchHit) => {
  const { artefacts } = await testData();
  return artefacts.manifest.editions[artefacts.units.edition[hit.unitIndex]];
};

Deno.test("the whole query matches as one phrase", async () => {
  const data = await testData();
  const hits = search(data.artefacts, "liberty of the press");
  assert(hits.length > 0);
  for (const hit of hits) {
    assert(/liberty of the press/i.test(unitText(data, hit.unitIndex)));
  }
  // the words must be consecutive and in order: a scramble finds nothing
  assertEquals(search(data.artefacts, "press the of liberty").length, 0);
});

Deno.test("tolerant search matches variant spellings and plurals", async () => {
  const data = await testData();
  // solo §1.2 #2 reads "the connexion betwixt causes and effects"
  const hits = search(data.artefacts, "connection between cause and effect");
  assertEquals(hits.length, 1);
  assert(
    /connexion betwixt causes and effects/.test(
      unitText(data, hits[0].unitIndex),
    ),
  );
  assertEquals((await editionOf(hits[0])).work, "solo");
});

Deno.test("a phrase needs its words adjacent, not merely co-occurring", async () => {
  const { artefacts } = await testData();
  // "agreeable sensation" is one phrase in the text
  assert(search(artefacts, "agreeable sensation").length > 0);
  // reversed, the phrase is gone
  assertEquals(search(artefacts, "sensation agreeable").length, 0);
  // two words from different paragraphs never form a phrase
  assertEquals(search(artefacts, "agreeable avarice").length, 0);
});

Deno.test("exactSpelling matches the spelling as written", async () => {
  const { artefacts } = await testData();
  const ALL = { work: "tw", edition: "all" };
  // tolerant unifies the spellings across both tw editions
  assertEquals(search(artefacts, "encrease", ALL).length, 2);
  assertEquals(search(artefacts, "increase", ALL).length, 2);
  // exact pins each to its own spelling
  const old = search(artefacts, "encrease", { edition: "all" }, EXACT);
  assertEquals(old.length, 1);
  assertEquals((await editionOf(old[0])).edition, "1750");
  assertEquals(
    search(artefacts, "increase", { edition: "all" }, EXACT).length,
    1,
  );
  // case is still folded at the exact layer
  assertEquals(
    search(artefacts, "ENCREASE", { edition: "all" }, EXACT).length,
    1,
  );
});

Deno.test("caseSensitive requires initial capitalisation to agree", async () => {
  const { artefacts } = await testData();
  const ALL = { edition: "all" };
  // "Avarice" appears only capitalised in the fixture (in non-canonical 1750)
  const any = search(artefacts, "avarice", ALL);
  assert(any.length > 0);
  assertEquals(search(artefacts, "Avarice", ALL, CASED).length, any.length);
  assertEquals(search(artefacts, "avarice", ALL, CASED).length, 0);
  // and a lowercase word: "liberty" is never capitalised here
  assert(search(artefacts, "liberty", ALL, CASED).length > 0);
  assertEquals(search(artefacts, "Liberty", ALL, CASED).length, 0);
});

Deno.test("filters restrict results to an author, work, and edition", async () => {
  const { artefacts } = await testData();
  const hits = search(artefacts, "sensation", {
    author: "test",
    work: "tw",
    edition: "1750",
  });
  assert(hits.length > 0);
  for (const hit of hits) {
    const ref = await editionOf(hit);
    assertEquals([ref.author, ref.work, ref.edition], ["test", "tw", "1750"]);
  }
  assertEquals(search(artefacts, "sensation", { author: "other" }).length, 0);
});

Deno.test("borrowed documents are indexed under their own work only", async () => {
  const { artefacts } = await testData();
  // "avarice" appears only in tw/1750 (non-canonical), which comp borrows
  const hits = search(artefacts, "avarice", { edition: "all" });
  assert(hits.length > 0);
  for (const hit of hits) assertEquals((await editionOf(hit)).work, "tw");
  // comp's own inline essay is indexed under comp
  const inline = search(artefacts, "composite collection alone");
  assert(inline.length > 0);
  for (const hit of inline) assertEquals((await editionOf(hit)).work, "comp");
});

Deno.test("version selects the edited or original text for single words", async () => {
  const { artefacts } = await testData();
  // solo §1.1 #2: "[-corrcted-][+corrected+] the text and [+also+] revised"
  assertEquals(search(artefacts, "corrected", {}, EXACT).length, 1);
  assertEquals(search(artefacts, "corrcted", {}, EXACT).length, 0);
  assertEquals(
    search(artefacts, "corrcted", {}, EXACT, "original").length,
    1,
  );
  // "also" is inserted, so it belongs to the edited text only
  assertEquals(search(artefacts, "also", {}, EXACT).length, 1);
  assertEquals(search(artefacts, "also", {}, EXACT, "original").length, 0);
});

Deno.test("a phrase across an editorial correction matches the right version", async () => {
  const { artefacts } = await testData();
  // edited reads "and also revised"; original reads "and revised"
  assertEquals(
    search(artefacts, "and also revised", {}, undefined, "edited").length,
    1,
  );
  assertEquals(
    search(artefacts, "and revised", {}, undefined, "edited").length,
    0,
  );
  assertEquals(
    search(artefacts, "and revised", {}, undefined, "original").length,
    1,
  );
  assertEquals(
    search(artefacts, "and also revised", {}, undefined, "original").length,
    0,
  );
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
  const hits = search(data.artefacts, "natural liberty of");
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
  const hits = search(data.artefacts, "recorded");
  assertEquals(hits.length, 1);
  const block = await readUnitBlock(data.artefacts, hits[0].unitIndex);
  const text = blockText(block);
  assert(text.includes("recorded")); // re//42//corded in the source
  const ranges = matchRanges(text, hits[0].positions);
  const highlighted = highlightBlock(block, ranges);
  assertEquals(blockText(highlighted), text);
});
