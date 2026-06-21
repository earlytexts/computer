/**
 * computer.search — phrase matching and its two independent knobs (the match
 * level exact/spelling/form, and caseSensitive), edition scoping and filters,
 * the edited/original version, the highlighted result blocks, and pagination.
 * The whole query matches as one phrase: words consecutive and in order.
 */

import { assert, assertEquals } from "@std/assert";
import { openTestComputer, testComputer } from "../helpers.ts";
import { corpus } from "../corpus.ts";
import { marks } from "../markit.ts";
import type { Computer, SearchParams } from "../../src/types.ts";

/** Total hits for a query (with the rest of the params). */
const count = async (
  computer: Computer,
  q: string,
  params: Partial<SearchParams> = {},
): Promise<number> => (await computer.search({ q, ...params })).total;

Deno.test("the whole query matches as one consecutive phrase", async () => {
  const computer = await testComputer();
  assert(await count(computer, "liberty of the press") > 0);
  // a scramble of the same words, no longer consecutive, finds nothing
  assertEquals(await count(computer, "press the of liberty"), 0);
  // co-occurring but not adjacent: nothing
  assert(await count(computer, "agreeable sensation") > 0);
  assertEquals(await count(computer, "sensation agreeable"), 0);
});

Deno.test("tolerant search unites variant spellings and inflections", async () => {
  const computer = await testComputer();
  // solo reads "the connexion betwixt causes and effects"
  const found = await computer.search({
    q: "connection between cause and effect",
  });
  assertEquals(found.total, 1);
  assertEquals(found.results[0].work, "solo");
  assertEquals(found.match, "form"); // the tolerant default
  assertEquals(found.caseSensitive, false);
});

Deno.test("match=exact pins to the spelling as written; form/spelling widen", async () => {
  const computer = await testComputer();
  const all = { edition: "all" } as const;
  // tolerant (form) unites the two tw spellings: encrease/increase, both ways
  assertEquals(await count(computer, "encrease", { ...all, work: "tw" }), 2);
  assertEquals(await count(computer, "increase", { ...all, work: "tw" }), 2);
  // exact pins each to its own surface
  const old = await computer.search({ q: "encrease", ...all, match: "exact" });
  assertEquals(old.total, 1);
  assertEquals(old.results[0].edition, "1750");
  assertEquals(
    await count(computer, "increase", { ...all, match: "exact" }),
    1,
  );
  // case is still folded at the exact layer
  assertEquals(
    await count(computer, "ENCREASE", { ...all, match: "exact" }),
    1,
  );
});

Deno.test("match=spelling unites spellings but keeps the surface inflection", async () => {
  const computer = await testComputer();
  // spelling unites encrease/increase across the two tw editions
  assertEquals(
    await count(computer, "encrease", {
      work: "tw",
      edition: "all",
      match: "spelling",
    }),
    2,
  );
  // but it does not collapse inflections: "cause" stays distinct from "causes"
  assertEquals(await count(computer, "cause and effect"), 1); // form
  assertEquals(
    await count(computer, "cause and effect", { match: "spelling" }),
    0,
  );
});

Deno.test("caseSensitive requires initial capitalisation to agree", async () => {
  const computer = await testComputer();
  const all = { edition: "all" } as const;
  const any = await count(computer, "avarice", all); // "Avarice" in the source
  assert(any > 0);
  assertEquals(
    await count(computer, "Avarice", { ...all, caseSensitive: true }),
    any,
  );
  assertEquals(
    await count(computer, "avarice", { ...all, caseSensitive: true }),
    0,
  );
  // "liberty" is lowercase in the source
  assert(await count(computer, "liberty", { ...all, caseSensitive: true }) > 0);
  assertEquals(
    await count(computer, "Liberty", { ...all, caseSensitive: true }),
    0,
  );
});

Deno.test("filters restrict to an author, work, and edition", async () => {
  const computer = await testComputer();
  const filtered = await computer.search({
    q: "sensation",
    author: "test",
    work: "tw",
    edition: "1750",
  });
  assert(filtered.total > 0);
  assert(filtered.results.every((r) => r.edition === "1750"));
  assertEquals(await count(computer, "sensation", { author: "other" }), 0);
});

Deno.test("borrowed text is indexed under its own work only", async () => {
  const computer = await testComputer();
  // "avarice" lives only in tw/1750, which comp borrows — still attributed to tw
  const borrowed = await computer.search({ q: "avarice", edition: "all" });
  assert(borrowed.total > 0);
  assert(borrowed.results.every((r) => r.work === "tw"));
  // comp's own inline essay is indexed under comp
  const inline = await computer.search({ q: "composite collection alone" });
  assert(inline.total > 0);
  assert(inline.results.every((r) => r.work === "comp"));
});

Deno.test("scope is canonical by default and widens with edition=all", async () => {
  const computer = await testComputer();
  // tolerant "encrease" matches "increase" in the canonical 1760
  const canonical = await computer.search({ q: "encrease" });
  assertEquals(canonical.total, 1);
  assertEquals(canonical.results[0].edition, "1760");
  // edition=all reaches the non-canonical 1750 too
  assertEquals(await count(computer, "encrease", { edition: "all" }), 2);
});

Deno.test("version selects the edited or original text", async () => {
  const computer = await testComputer();
  // solo §1.1 #2: "[-corrcted-][+corrected+] the text and [+also+] revised it."
  assertEquals(await count(computer, "corrected", { match: "exact" }), 1);
  assertEquals(await count(computer, "corrcted", { match: "exact" }), 0);
  assertEquals(
    await count(computer, "corrcted", { match: "exact", version: "original" }),
    1,
  );
  // "also" is an editorial insertion: it belongs to the edited text only
  assertEquals(await count(computer, "also", { match: "exact" }), 1);
  assertEquals(
    await count(computer, "also", { match: "exact", version: "original" }),
    0,
  );
});

Deno.test("results carry full formatted blocks with the phrase marked", async () => {
  const computer = await testComputer();
  const found = await computer.search({ q: "liberty of the press" });
  assert(found.total > 0);
  const first = found.results[0];
  assertEquals(first.author, "test");
  assertEquals(first.authorName, "Test");
  assertEquals(first.work, "tw");
  assertEquals(first.workBreadcrumb, "Test Work");
  assert(first.block.content.length > 0);
  assertEquals(marks(first.block.content), ["liberty of the press"]);
});

Deno.test("a phrase marked across a formatting boundary stays one match", async () => {
  const computer = await testComputer();
  // "natural _liberty_ of": liberty sits inside an emphasis wrapper, so the
  // phrase is marked in fragments that read contiguously.
  const found = await computer.search({ q: "natural liberty of" });
  assertEquals(found.total, 1);
  assertEquals(marks(found.results[0].block.content), [
    "natural ",
    "liberty",
    " of",
  ]);
});

Deno.test("BM25 ranking saturates term frequency and normalises by length", async () => {
  // Three single-block works, all canonical, each carrying "widget" once or
  // thrice in a short or long block. BM25 should rank the dense short block
  // first (more occurrences, saturating), then the sparse short block, then the
  // long block (its single hit diluted by length).
  const filler = "filler ".repeat(40);
  const meta = (slug: string) => ({
    title: slug,
    breadcrumb: slug,
    published: [1700],
    canonical: "1700",
  });
  const ed = (slug: string) => ({
    imported: true,
    title: slug,
    breadcrumb: slug,
    published: [1700],
  });
  const files = corpus()
    .author("z", { forename: "Z", surname: "Zed", published: 1700 })
    .work("z", "sparse", meta("sparse"))
    .edition(
      "z",
      "sparse",
      "1700",
      ed("sparse"),
      "{#1}\nAlpha beta widget gamma.",
    )
    .work("z", "dense", meta("dense"))
    .edition(
      "z",
      "dense",
      "1700",
      ed("dense"),
      "{#1}\nAlpha widget widget widget beta gamma.",
    )
    .work("z", "long", meta("long"))
    .edition(
      "z",
      "long",
      "1700",
      ed("long"),
      `{#1}\n${filler}widget ${filler}.`,
    )
    .build();

  const { computer } = await openTestComputer(files);
  const found = await computer.search({ q: "widget" });
  assertEquals(found.results.map((r) => r.work), ["dense", "sparse", "long"]);
  // Scores are strictly descending and positive (a well-formed BM25 value).
  const scores = found.results.map((r) => r.score);
  assert(scores.every((s) => s > 0));
  assert(scores[0] > scores[1] && scores[1] > scores[2]);
});

Deno.test("an empty query matches nothing", async () => {
  const computer = await testComputer();
  assertEquals((await computer.search({ q: "" })).total, 0);
});

Deno.test("results paginate", async () => {
  const computer = await testComputer();
  const paged = await computer.search({
    q: "paragraph",
    edition: "all",
    perPage: 1,
    page: 2,
  });
  assertEquals(paged.page, 2);
  assertEquals(paged.results.length, 1);
  assert(paged.pages > 1);
});
