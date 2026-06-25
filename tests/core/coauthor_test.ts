/**
 * Multiple authors per work: a co-authored work appears under each of its
 * authors in the catalog, resolves under either, carries both authors in its
 * read responses, and attributes each letter (section) to its writer. Search
 * and frequency treat the author scope as membership, so a co-author's filter
 * finds the shared work. Built over the in-memory co-author corpus.
 */

import { assert, assertEquals } from "@std/assert";
import { buildArtefactsToDisk } from "../../src/core/pipeline.ts";
import { coauthorCorpus, CORPUS_ROOT } from "../corpus.ts";
import { memoryHarness, openTestComputer } from "../helpers.ts";

const coComputer = () => openTestComputer(coauthorCorpus());

Deno.test("a co-authored work is listed under each of its authors", async () => {
  const { computer } = await coComputer();
  const catalog = await computer.catalog();
  const bell = catalog.authors.find((a) => a.slug === "bell")!;
  const dee = catalog.authors.find((a) => a.slug === "dee")!;
  // The work lives once on disk (under bell) but appears under both.
  assert(bell.works.some((w) => w.slug === "corr"));
  assert(dee.works.some((w) => w.slug === "corr"));
  const corr = dee.works.find((w) => w.slug === "corr")!;
  assertEquals(corr.authorSlugs, ["bell", "dee"]);
  // dee has only the shared work; its solo/ghost works stay under bell.
  assertEquals(dee.works.map((w) => w.slug), ["corr"]);
});

Deno.test("a co-authored work resolves under either author", async () => {
  const { computer } = await coComputer();
  const viaBell = await computer.edition("bell", "corr");
  const viaDee = await computer.edition("dee", "corr");
  assert(viaBell !== undefined);
  assert(viaDee !== undefined);
  // Both views carry both authors, in title order, with their metadata.
  for (const edition of [viaBell, viaDee]) {
    assertEquals(edition!.authors.map((a) => a.slug), ["bell", "dee"]);
    assertEquals(edition!.authors.map((a) => a.surname), ["Bell", "Dee"]);
  }
});

Deno.test("each letter is attributed to its own author", async () => {
  const { computer } = await coComputer();
  const edition = await computer.edition("bell", "corr");
  // Section summaries cascade the per-letter `authors` override.
  assertEquals(edition!.sections.map((s) => s.authors), [["bell"], ["dee"]]);

  const letter1 = await computer.section("bell", "corr", undefined, ["1"]);
  const letter2 = await computer.section("dee", "corr", undefined, ["2"]);
  assertEquals(letter1!.section.authors, ["bell"]);
  assertEquals(letter2!.section.authors, ["dee"]);
});

Deno.test("a solo work's sections inherit the work's single author", async () => {
  const { computer } = await coComputer();
  const solo = await computer.edition("bell", "solo");
  assertEquals(solo!.authors.map((a) => a.slug), ["bell"]);
  assertEquals(solo!.sections.map((s) => s.authors), [["bell"]]);
});

Deno.test("an author scope is membership: a co-author's filter finds the work", async () => {
  const { computer } = await coComputer();
  // "liberty" occurs only in letter 2 (dee's), within the bell-hosted work.
  const viaDee = await computer.search({ q: "liberty", author: "dee" });
  assert(viaDee.results.some((r) => r.work === "corr"));
  const hit = viaDee.results.find((r) => r.work === "corr")!;
  assertEquals(hit.authors, ["bell", "dee"]);
  assertEquals(hit.authorNames, ["Bell", "Dee"]);
  // bell's filter finds the shared work too (membership, not equality).
  const viaBell = await computer.search({ q: "liberty", author: "bell" });
  assert(viaBell.results.some((r) => r.work === "corr"));
});

Deno.test("frequency by author splits a co-authored work across both authors", async () => {
  const { computer } = await coComputer();
  const freq = await computer.frequency({
    q: "virtue",
    groupBy: "author",
    editions: "all",
  });
  // "virtue" is in the shared work (letter 1) and in bell's solo work; grouped
  // by author it credits both bell and dee, each as a single-author row.
  const bell = freq.results.find((r) => r.authors[0] === "bell");
  const dee = freq.results.find((r) => r.authors[0] === "dee");
  assert(bell !== undefined && bell.authors.length === 1);
  assert(dee !== undefined && dee.authors.length === 1);
  assert(dee.count >= 1);
});

Deno.test("naming a co-author with no author file warns but still builds", async () => {
  const harness = memoryHarness(coauthorCorpus());
  const built = await buildArtefactsToDisk(harness.io, CORPUS_ROOT, "memory");
  assert(
    built.manifest.warnings.some((w) =>
      w.includes("co-author") && w.includes("zz")
    ),
    "expected a phantom co-author warning",
  );
  // The phantom author still appears in the catalog, carrying the ghost work.
  const { computer } = await openTestComputer(coauthorCorpus());
  const catalog = await computer.catalog();
  const zz = catalog.authors.find((a) => a.slug === "zz");
  assert(zz !== undefined);
  assert(zz.works.some((w) => w.slug === "ghost"));
});
