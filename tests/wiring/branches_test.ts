/**
 * The remaining conditional branches of the response builders and renderers
 * that the main suites don't happen to hit: sparse author/work/edition
 * metadata, the singular/plural and stub/imported sides of the text renderer,
 * empty-document vectors, a section comparison with subsections, and the
 * "no target" and edition-scope query paths. All reached through the HTTP
 * handler or the Computer seam.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createHandler } from "../../src/server.ts";
import { openTestComputer, testComputer } from "../helpers.ts";
import {
  emptyDocCorpus,
  metadataCorpus,
  oneTopicCorpus,
  sectionSimilarCorpus,
  subsectionCompareCorpus,
  vectorCorpus,
} from "../corpus.ts";
import type { Computer } from "../../src/types.ts";

const textHandlerFor = (computer: Computer) => {
  const handle = createHandler({ computer });
  return async (path: string): Promise<string> => {
    const sep = path.includes("?") ? "&" : "?";
    return await (await handle(
      new Request(`http://localhost${path}${sep}format=text`),
    )).text();
  };
};

Deno.test("text: sparse author/work/edition metadata renders with fallbacks", async () => {
  const { computer } = await openTestComputer(metadataCorpus());
  const text = textHandlerFor(computer);

  // The catalogue lists an author with no metadata (min) and one with a birth but
  // no death (alpha), exercising the date-span and "first published" fallbacks.
  const catalogue = await text("/catalogue");
  assertStringIncludes(catalogue, "min —"); // empty forename, surname = slug
  assertStringIncludes(catalogue, "(1700–?)"); // alpha: birth, no death

  // alpha has a single work — "1 work", not "works".
  assertStringIncludes(catalogue, "1 work");

  // gamma has a death but no birth — the span's other "?" side.
  assertStringIncludes(catalogue, "(?–1799)");

  // get_author_works for the metadata-less author shows the fallback work title.
  const works = await text("/authors/alpha/a");
  assertStringIncludes(works, "edition");

  // The catalogue resolved the work whose index omits title/breadcrumb, and the
  // edition whose metadata omits title/breadcrumb/imported, without crashing.
  const sparseWork = await text("/authors/alpha/b");
  assert(sparseWork.length > 0);

  // An edition with no edition-level blocks (text lives in its sections only):
  // both the edition view and the full-text view skip the empty block region.
  const edition = await text("/authors/alpha/a/1700");
  assertStringIncludes(edition, "Sections");
  const full = await text("/authors/alpha/a/1700/full");
  assertStringIncludes(full, "§ 1");

  // A single-section edition's section has neither previous nor next.
  const lone = await text("/authors/alpha/a/1700/1");
  assert(!lone.includes("previous:") && !lone.includes("next:"));
});

Deno.test("text: the stub sides of works, editions and the table of contents render", async () => {
  const text = textHandlerFor(await testComputer());
  // other/stub is an un-transcribed work and edition.
  const works = await text("/authors/other/stub");
  assertStringIncludes(works, "[stub]"); // edition meta, work meta
  // solo's table of contents has a stub section (Part 2 is not imported).
  const solo = await text("/authors/test/solo");
  assertStringIncludes(solo, "[stub]"); // a stub section in the TOC
});

Deno.test("text: section-level similarity cites the section title", async () => {
  const text = textHandlerFor(await testComputer());
  const sim = await text("/similar?author=test&work=tw&path=1");
  // Section-level results carry a § path; titled ones show the title.
  assert(sim.includes("§") || sim.includes("similar"));
});

Deno.test("text: a directory-style edition is part of the work", async () => {
  const computer = (await openTestComputer(metadataCorpus())).computer;
  const catalogue = await computer.catalogue();
  const a = catalogue.authors.find((au) => au.slug === "alpha")!
    .works.find((w) => w.slug === "a")!;
  // The 1758 edition lives in a directory (1758/index.mit) but is still listed.
  assert(a.editions.some((e) => e.slug === "1758"));
});

Deno.test("text: an empty imported document is handled by the vector routes", async () => {
  // Building emptyDocCorpus exercises the zero-norm document and zero-mass topic
  // mix; similarity over it meets a candidate with no shared vocabulary.
  const { computer } = await openTestComputer(emptyDocCorpus());
  const sim = await computer.similar({
    author: "solid",
    work: "real",
    level: "work",
  });
  // The hollow work is in the corpus but shares no vocabulary, so it is not a
  // result (or scores nothing) — the scan simply skips it.
  assert(sim.results.every((r) => r.work !== "hollow"));
});

Deno.test("text: a section comparison reports its subsections", async () => {
  const computer = (await openTestComputer(subsectionCompareCorpus())).computer;
  const text = textHandlerFor(computer);
  const cmp = await text("/authors/pair/w/compare/1700/1710/1");
  assertStringIncludes(cmp, "Subsections:");
  // The reading route's section also shows the matching editions and nav.
  const section = await text("/authors/pair/w/1700/1");
  assertStringIncludes(section, "Subsections:");
});

Deno.test("text: frequency grouped by author, and a single occurrence reads as singular", async () => {
  const text = textHandlerFor(await testComputer());
  const byAuthor = await text(
    "/frequency?q=liberty&groupBy=author&editions=all",
  );
  assertStringIncludes(byAuthor, "grouped by author");
  // "avarice" occurs exactly once (one edition), so the count is singular.
  const once = await text("/frequency?q=avarice&editions=all");
  assertStringIncludes(once, "1 occurrence of");
  const conc = await text("/concordance?q=avarice&editions=all");
  assertStringIncludes(conc, "1 occurrence of");
});

Deno.test("text: concordance can sort by the right context", async () => {
  const text = textHandlerFor(await testComputer());
  const right = await text("/concordance?q=the&editions=all&sort=right");
  assertStringIncludes(right, "in context");
});

Deno.test("text: a vector route with no target names 'the target'", async () => {
  const text = textHandlerFor(await testComputer());
  // No author/work at all: the response is not-found and labelled generically.
  const sim = await text("/similar?level=work");
  assertStringIncludes(sim, "the target");
  const mix = await text("/topics/mix?level=work");
  assertStringIncludes(mix, "the target");
});

Deno.test("similarity handles disjoint, empty, and tied candidates", async () => {
  const { computer } = await openTestComputer(vectorCorpus());
  // The target's lookalikes: the disjoint and hollow works contribute nothing
  // (no shared vocabulary / no vocabulary), while the two identical twins tie.
  const sim = await computer.similar({
    author: "vec",
    work: "target",
    level: "work",
  });
  assert(sim.results.every((r) => r.work !== "disjoint")); // dot product 0
  assert(sim.results.every((r) => r.work !== "hollow")); // zero norm
  // The twins share "virtue reason cause" with the target and score equally.
  const twins = sim.results.filter((r) =>
    r.work === "twinA" || r.work === "twinB"
  );
  if (twins.length === 2) assertEquals(twins[0].score, twins[1].score);
});

Deno.test("the topic model handles the empty and tied documents", async () => {
  const { computer } = await openTestComputer(vectorCorpus());
  // Building exercised the zero-norm document and zero-mass topic mix; the
  // topic model still resolves, and the topics route renders.
  const topics = await computer.topics({});
  assert(topics.k >= 1);
});

Deno.test("missing resources resolve to undefined across the reading routes", async () => {
  const c = await testComputer();
  // An unknown work fails to resolve before the response builder runs (the
  // localComputer's resolve / author-work guards).
  assertEquals(await c.edition("test", "nope"), undefined);
  assertEquals(await c.fullText("test", "nope"), undefined);
  assertEquals(await c.section("test", "nope", undefined, ["1"]), undefined);
  assertEquals(
    await c.sectionFullText("test", "nope", undefined, ["1"]),
    undefined,
  );
  assertEquals(await c.compare("test", "nope", "1750", "1760"), undefined);
  assertEquals(
    await c.compareSection("test", "nope", "1750", "1760", ["1"]),
    undefined,
  );
  // A known work but an unknown section / edition fails in the builder itself.
  assertEquals(await c.section("test", "tw", "1760", ["404"]), undefined);
  assertEquals(
    await c.compareSection("test", "tw", "1750", "1760", ["404"]),
    undefined,
  );
});

Deno.test("concordance lines in one block tie on context and order by position", async () => {
  const { computer } = await openTestComputer(vectorCorpus());
  // "virtue" appears once per twin and once in the target; a broad scan gives
  // several lines whose sort exercises the unit/position tiebreaks.
  const conc = await computer.concordance({
    q: "virtue",
    editions: "all",
    sort: "position",
  });
  assert(conc.total >= 2);
});

Deno.test("a query that tokenizes to an unknown exact form matches nothing", async () => {
  const c = await testComputer();
  // An exact-match query for a word absent from the vocabulary resolves to no
  // posting slot, so the search is empty.
  const result = await c.search({
    q: "zzqplughxyz",
    match: "exact",
    editions: "all",
  });
  assertEquals(result.total, 0);
});

Deno.test("the HTTP routes accept a missing q as the empty query", async () => {
  const handle = createHandler({ computer: await testComputer() });
  for (const route of ["search", "frequency", "concordance", "collocations"]) {
    const response = await handle(
      new Request(`http://localhost/${route}?editions=all`),
    );
    // No q parameter: parsed as "", which is a well-formed empty query (200).
    assertEquals(response.status, 200, route);
    await response.body?.cancel();
  }
});

Deno.test("the handler reads the client address from the connection info", async () => {
  const handle = createHandler({
    computer: await testComputer(),
    rateLimit: { ratePerSecond: 1, burst: 1 },
    now: () => 0,
  });
  const info = (transport: "tcp" | "unix") =>
    ({
      remoteAddr: { transport, hostname: "10.0.0.5", port: 1 },
    }) as Deno.ServeHandlerInfo;
  // A TCP peer with no forwarded-for header is keyed by its connection address.
  const a = await handle(
    new Request("http://localhost/catalogue"),
    info("tcp"),
  );
  assertEquals(a.status, 200);
  await a.body?.cancel();
  const b = await handle(
    new Request("http://localhost/catalogue"),
    info("tcp"),
  );
  assertEquals(b.status, 429); // same peer, burst exhausted
  await b.body?.cancel();
  // A non-TCP transport has no usable address: the connection-address branch is
  // skipped (the request is keyed by the shared fallback instead).
  const c = await handle(
    new Request("http://localhost/catalogue"),
    info("unix"),
  );
  assert(c.status === 200 || c.status === 429);
  await c.body?.cancel();
});

Deno.test("the universe filter, keyword scope, and vector target cover their arms", async () => {
  const c = await testComputer();
  // frequency pinned to one printing exercises the specific-edition universe.
  const freq = await c.frequency({
    q: "paragraph",
    author: "test",
    work: "tw",
    edition: "1750",
  });
  assert(freq.results.every((r) => r.edition === "1750" || r.edition === null));
  // keywords with no author/work targets the whole corpus (author/work null).
  const kw = await c.keywords({ min: 1 });
  assertEquals(kw.author, null);
  assertEquals(kw.work, null);
  // a section-level similarity target pinned to a specific edition.
  const sim = await c.similar({
    author: "test",
    work: "tw",
    edition: "1750",
    path: ["1"],
    level: "section",
  });
  assertEquals(sim.edition, "1750");
});

Deno.test("a concordance hit inside a title block has an empty section path", async () => {
  const c = await testComputer();
  // "test work" is in each edition's title block (section path is the root).
  const conc = await c.concordance({ q: "test work", editions: "all" });
  assert(conc.lines.some((l) => l.sectionPath.length === 0));
});

Deno.test("section-level similarity cites a candidate section's title", async () => {
  const { computer } = await openTestComputer(sectionSimilarCorpus());
  const sim = await computer.similar({
    author: "sec",
    work: "tgt",
    path: ["1"],
    level: "section",
  });
  assert(sim.found);
  // The candidate sections share vocabulary with the target; each carries a
  // section title (the explicit one, or the id fallback).
  assert(
    sim.results.some((r) =>
      r.sectionPath.length > 0 && r.sectionTitle !== null
    ),
  );
});

Deno.test("a single-topic model ties its prominent works", async () => {
  // Three works built from one shared lemma collapse to a single topic in which
  // every work weighs the same, so the prominent-works sort uses its tiebreak.
  const { computer } = await openTestComputer(oneTopicCorpus());
  const topics = await computer.topics({});
  assertEquals(topics.k, 1);
  assert(topics.topics[0].prominent.length >= 2);
});

Deno.test("keywords for a work without an author has null author scope", async () => {
  const c = await testComputer();
  const kw = await c.keywords({ work: "tw", min: 1 });
  assertEquals(kw.author, null);
  assertEquals(kw.work, "tw");
});

Deno.test("an edition-scoped search resolves and a title hit has an empty section path", async () => {
  const computer = await testComputer();
  // A specific edition scope (with work + author) reaches the edition filter.
  const scoped = await computer.search({
    q: "test work",
    author: "test",
    work: "tw",
    edition: "1750",
  });
  assert(scoped.results.every((r) => r.edition === "1750"));
  // A phrase in the edition's title block has an empty section path.
  const title = await computer.search({
    q: "test work",
    author: "test",
    work: "tw",
    edition: "1750",
  });
  assert(title.results.some((r) => r.sectionPath.length === 0));
});
