/**
 * Edge branches of the analysis routes that the main behavioural suites don't
 * happen to reach: the form/original keyword paths, a query that tokenizes to
 * nothing, an author scope that excludes another author, a collocation scan
 * that steps over units without the node word, a tie in the concordance sort,
 * an untranscribed similarity target, and a work-level topic mix missing its
 * coordinates. All driven through the `Computer` seam.
 */

import { assert, assertEquals } from "@std/assert";
import {
  corpus,
  emptyCorpus,
  openableTwoAuthor,
  richCorpus,
} from "../corpus.ts";
import { openTestComputer, testComputer } from "../helpers.ts";

Deno.test("keywords: form grouping and original-version counting both work", async () => {
  const c = await testComputer();
  const byForm = await c.keywords({
    author: "test",
    work: "tw",
    by: "form",
    min: 1,
  });
  assertEquals(byForm.by, "form");
  // solo carries editorial markup, so the original text is read from the overlay.
  const original = await c.keywords({
    author: "test",
    work: "solo",
    version: "original",
    min: 1,
  });
  assertEquals(original.version, "original");
});

Deno.test("search: a punctuation-only query matches nothing; a work scope filters", async () => {
  const c = await testComputer();
  assertEquals((await c.search({ q: "!!!", editions: "all" })).total, 0);
  // "the" occurs in several works, so a tw work-scope must filter out the
  // candidate units from solo and comp.
  const scoped = await c.search({
    q: "the",
    author: "test",
    work: "tw",
    editions: "all",
  });
  assert(scoped.total > 0);
  assert(scoped.results.every((r) => r.work === "tw"));
});

Deno.test("collocations: the scan steps over in-scope editions without the node word", async () => {
  const c = await testComputer();
  // "liberty" is in some editions but not all, so the scan skips the editions
  // where the node word never occurs.
  const col = await c.collocations({ q: "liberty", editions: "all", min: 1 });
  assert(col.nodeCount > 0);
});

Deno.test("concordance: a left-sort with identical contexts is a stable tie", async () => {
  const { computer } = await openTestComputer(richCorpus());
  const con = await computer.concordance({
    q: "echo",
    sort: "left",
    editions: "all",
  });
  assert(con.total >= 2);
});

Deno.test("concordance: several occurrences in one block order by position", async () => {
  // "echo echo echo echo" puts several occurrences in a single unit, so the
  // default position sort falls through to the unit/start tiebreak.
  const { computer } = await openTestComputer(richCorpus());
  const con = await computer.concordance({
    q: "echo",
    editions: "all",
    sort: "position",
  });
  assert(con.total >= 2);
});

Deno.test("similar: an untranscribed target has nothing to compare", async () => {
  const { computer } = await openTestComputer(emptyCorpus());
  const sim = await computer.similar({
    author: "void",
    work: "stub",
    level: "work",
  });
  assertEquals(sim.results.length, 0);
});

Deno.test("topicMix: a work-level target without a work is not found", async () => {
  const c = await testComputer();
  const mix = await c.topicMix({ author: "test", level: "work" });
  assertEquals(mix.found, false);
});

Deno.test("topicMix: a stub target within a real model aggregates an empty mix", async () => {
  // The model has one transcribed work, so it is non-empty; the requested work
  // is a stub with no document, so its mix aggregates to zero and is not found.
  const body = (line: string) =>
    `## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\n${line}`;
  const mixed = corpus()
    .author("m", { forename: "Mae", surname: "Mm" })
    .work("m", "real", {
      title: "R",
      breadcrumb: "R",
      canonical: "1700",
    })
    .edition("m", "real", "1700", {
      imported: true,
      title: "R",
      breadcrumb: "R",
      published: [1700],
    }, body("philosophy virtue reason passion liberty nature understanding."))
    .work("m", "ghost", {
      title: "G",
      breadcrumb: "G",
      canonical: "1700",
    })
    .edition("m", "ghost", "1700", {
      imported: false,
      title: "G",
      breadcrumb: "G",
      published: [1700],
    })
    .build();
  const { computer } = await openTestComputer(mixed);
  const mix = await computer.topicMix({
    author: "m",
    work: "ghost",
    level: "work",
  });
  assertEquals(mix.found, false);
});

Deno.test("frequency: an author scope excludes other authors' editions", async () => {
  const { computer } = await openTestComputer(openableTwoAuthor());
  const freq = await computer.frequency({
    q: "virtue",
    author: "a",
    editions: "all",
  });
  assert(freq.total > 0);
  assert(freq.results.every((r) => r.authors.includes("a")));
  // sanity: the word is in both authors when unscoped
  const all = await computer.frequency({ q: "virtue", editions: "all" });
  assert(all.results.some((r) => r.authors.includes("b")));
});

Deno.test("frequency: a work scope excludes the author's other works", async () => {
  const c = await testComputer();
  // "the" occurs across solo, tw and comp; scoping to tw drops the rest.
  const freq = await c.frequency({
    q: "the",
    author: "test",
    work: "tw",
    editions: "all",
  });
  assert(freq.total > 0);
  assert(freq.results.every((r) => r.work === "tw"));
});
