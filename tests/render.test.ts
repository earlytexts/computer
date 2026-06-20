import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  renderAuthors,
  renderBlocks,
  renderCompareSection,
  renderSearch,
  renderSection,
  renderWorks,
} from "../src/lib/serve/render.ts";
import {
  catalog,
  highlighted,
  paragraph,
  plain,
  search,
  section,
} from "./toolFixtures.ts";
import type { InlineElement } from "@earlytexts/markit";
import type { CompareSectionResponse } from "../src/types.ts";

Deno.test("renderBlocks renders plain text and marks highlights", () => {
  const text = renderBlocks([
    paragraph("p1", [plain("the "), highlighted("flames"), plain(" of war")]),
  ]);
  assertEquals(text, "the «flames» of war");
});

Deno.test("renderAuthors gives one cited line per author", () => {
  const text = renderAuthors(catalog.authors);
  assertStringIncludes(text, "hume — David Hume (1711–1776)");
  assertStringIncludes(text, "Scottish");
  assertStringIncludes(text, "first published 1739");
});

Deno.test("renderWorks lists works with edition slugs", () => {
  const text = renderWorks(catalog.authors[0]);
  assertStringIncludes(
    text,
    "epm — An Enquiry concerning the Principles of Morals (1751)",
  );
  assertStringIncludes(text, "editions: 1751, 1772 (canonical)");
});

Deno.test("renderSearch cites each result and marks matches", () => {
  const text = renderSearch(search);
  assertStringIncludes(text, "1 blocks containing the phrase");
  assertStringIncludes(text, "hume/ehu/1772 § 12/3 (Part 3) [p34]");
  assertStringIncludes(text, "«flames»");
});

Deno.test("renderSearch reports empty results", () => {
  const text = renderSearch({ ...search, total: 0, results: [] });
  assertEquals(
    text,
    'No results for the phrase "flames" (exact spelling).',
  );
});

Deno.test("renderSection includes header, text, and navigation", () => {
  const text = renderSection(section);
  assertStringIncludes(
    text,
    'Hume, An Enquiry concerning the Principles of Morals — edition "1772"',
  );
  assertStringIncludes(text, "§ 1");
  assertStringIncludes(text, "Disputes with men");
  assertStringIncludes(text, "next: 2");
  assertStringIncludes(text, "Matching section also in editions: 1751");
});

Deno.test("renderSection flags stubs instead of showing text", () => {
  const text = renderSection({
    ...section,
    section: { ...section.section, imported: false, blocks: [] },
  });
  assertStringIncludes(
    text,
    "[stub — this section's text is not in the corpus]",
  );
});

Deno.test("renderCompareSection shows the diff document's editorial markup", () => {
  const del = (content: string): InlineElement => ({
    type: "deletion",
    content: [plain(content)],
  });
  const ins = (content: string): InlineElement => ({
    type: "insertion",
    content: [plain(content)],
  });
  // The computer returns the diff as a Markit document; companion shows its
  // deletions/insertions as [-…-]/{+…+}.
  const response: CompareSectionResponse = {
    author: catalog.authors[0],
    work: catalog.authors[0].works[0],
    a: catalog.authors[0].works[0].editions[1],
    b: catalog.authors[0].works[0].editions[0],
    version: "edited",
    title: "Section 1",
    aPath: ["1"],
    bPath: ["1"],
    compareEditions: [],
    blocks: [
      paragraph("p1", [
        plain("wisdom of the "),
        del("ancients"),
        ins("moderns"),
      ]),
    ],
    childRows: [],
  };
  const text = renderCompareSection(response);
  assertStringIncludes(text, "wisdom of the [-ancients-]{+moderns+}");
});
