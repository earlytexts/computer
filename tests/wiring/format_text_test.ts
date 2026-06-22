/**
 * The `?format=text` rendering seam (render.ts), reached through the HTTP
 * handler. The JSON contract is pinned in tests/core and http_test; here the
 * concern is only the plain-text projection the MCP tools and the text format
 * share: that every response type renders, that rich block structure (lists,
 * tables, block quotes, headings, editorial markup, highlights) survives the
 * projection, and that each "nothing found" branch produces its own message.
 */

import { assertStringIncludes } from "@std/assert";
import { createHandler } from "../../src/server.ts";
import { openTestComputer, testComputer } from "../helpers.ts";
import { bigDiffCorpus, emptyCorpus, richCorpus } from "../corpus.ts";
import type { Computer } from "../../src/types.ts";

const handlerFor = (computer: Computer) => {
  const handle = createHandler({ computer });
  return async (path: string): Promise<string> => {
    const sep = path.includes("?") ? "&" : "?";
    const response = await handle(
      new Request(`http://localhost${path}${sep}format=text`),
    );
    return await response.text();
  };
};

const richText = async () =>
  handlerFor((await openTestComputer(richCorpus())).computer);

Deno.test("text: an edition renders its blocks, lists, tables, and quotes", async () => {
  const text = await richText();
  const edition = await text("/authors/rich/anth/1700");
  assertStringIncludes(edition, "An Anthology");
  assertStringIncludes(edition, "ANTHOLOGY"); // the title heading
  // A full-text view walks the section content, including the rich block.
  const full = await text("/authors/rich/anth/1700/full");
  assertStringIncludes(full, "alpha"); // a list item
  assertStringIncludes(full, "Apple"); // a table cell
  assertStringIncludes(full, "quoted line"); // a block quote
});

Deno.test("text: a section shows its subsections and a stub marker", async () => {
  const text = await richText();
  // The rich section has child content listed as subsections.
  const section = await text("/authors/rich/anth/1700/1");
  assertStringIncludes(section, "MARGINAL HEADING");
  // A solo section that is not transcribed renders the stub marker.
  const stub = handlerFor(await testComputer());
  const stubSection = await stub("/authors/test/solo/2");
  assertStringIncludes(stubSection, "[stub");
  // A section with child sections lists them as subsections.
  const withSubs = await stub("/authors/test/solo/1");
  assertStringIncludes(withSubs, "Subsections:");
  // A full-text view of the same edition also marks the stub section.
  const stubFull = await stub("/authors/test/solo/full");
  assertStringIncludes(stubFull, "stub");
});

Deno.test("text: editorial markup and highlights become visible markers", async () => {
  const text = await richText();
  // version=both keeps the markup; render makes it visible as [-…-]/{+…+}.
  const both = await text("/authors/rich/anth/1700/1?version=both");
  assertStringIncludes(both, "[-mistook-]");
  assertStringIncludes(both, "{+corrected+}");
  // A search hit marks the phrase with «…».
  const search = await text("/search?q=maxim&editions=all");
  assertStringIncludes(search, "«maxim»");
});

Deno.test("text: a comparison renders the diff and the section alignment", async () => {
  const text = await richText();
  const section = await text("/authors/rich/anth/compare/1700/1710/1");
  assertStringIncludes(section, 'edition "1700" vs edition "1710"');
  assertStringIncludes(section, "[- ALPHA-]");
  assertStringIncludes(section, "{+ OMEGA+}");
  const work = await text("/authors/rich/anth/compare/1700/1710");
  assertStringIncludes(work, "aligned with edition");
  assertStringIncludes(work, "ONLY IN");
});

Deno.test("text: a case-sensitive search names the mode", async () => {
  const text = handlerFor(await testComputer());
  const result = await text("/search?q=liberty&caseSensitive=1&editions=all");
  assertStringIncludes(result, "case-sensitive");
});

Deno.test("text: every empty result renders its own message", async () => {
  const shared = handlerFor(await testComputer());
  assertStringIncludes(await shared("/search?q=zzdoesnotexist"), "No results");
  assertStringIncludes(
    await shared("/frequency?q=zzdoesnotexist"),
    "No occurrences",
  );
  assertStringIncludes(
    await shared("/concordance?q=zzdoesnotexist"),
    "No occurrences",
  );
  // A node word absent from the scope: no collocations at all.
  assertStringIncludes(
    await shared("/collocations?q=zzdoesnotexist"),
    "no collocations",
  );
  // A node word present, but no collocate meets a very high minimum.
  assertStringIncludes(
    await shared("/collocations?q=liberty&editions=all&min=9999"),
    "collocate meets the minimum",
  );
  // A target that does not exist: not found.
  assertStringIncludes(
    await shared("/similar?author=test&work=nope&level=work"),
    "No work found",
  );
  assertStringIncludes(
    await shared("/topics/mix?author=test&work=nope&level=work"),
    "no topic mix",
  );

  // Keywords for the never-transcribed author: too little text to be distinctive.
  assertStringIncludes(
    await shared("/keywords?author=other&min=1"),
    "No distinctive vocabulary",
  );
});

Deno.test("text: a corpus with no transcribed text has no topic model", async () => {
  const empty = handlerFor((await openTestComputer(emptyCorpus())).computer);
  assertStringIncludes(await empty("/topics"), "no topic model");
});

Deno.test("text: a target with text but nothing comparable is reported", async () => {
  // The big-diff work is the only work by its author and the only one with
  // text, so nothing in the corpus is similar to it.
  const big = handlerFor((await openTestComputer(bigDiffCorpus())).computer);
  assertStringIncludes(
    await big("/similar?author=big&work=tome&level=work"),
    "Nothing in the corpus is lexically similar",
  );
});
