/**
 * The artefact cache is an internal optimisation: this is the one test that
 * knows it exists. It pins the two properties the rest of the suite relies on
 * being invisible — the codec round-trips (a reopened computer answers exactly
 * as the freshly built one did), and freshness is honoured (an unchanged corpus
 * is not rebuilt, a changed one is). Everything else goes through `Computer` and
 * never sees an artefact.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { openComputer } from "../../src/core/mod.ts";
import { loadCatalog } from "../../src/core/build/catalog.ts";
import { memoryHarness } from "../helpers.ts";
import { CORPUS_ROOT, testCorpus } from "../corpus.ts";

const PATHS = { corpusDir: CORPUS_ROOT, artefactsDir: "memory" };

Deno.test("loadCatalog fails clearly when the corpus was not built", async () => {
  const reader = {
    readCatalogue: () => Promise.resolve(null),
    readDocument: () => Promise.resolve(null),
  };
  await assertRejects(
    () => loadCatalog(reader, "/no/such/corpus"),
    Error,
    "run the corpus build",
  );
});

Deno.test("loadCatalog reconstructs the catalog, incl. metadata-less docs", async () => {
  // A minimal compiled catalogue with one author, work, and edition whose
  // document carries no metadata (the branch the shared fixture never exercises).
  const reader = {
    readCatalogue: () =>
      Promise.resolve({
        authors: [{ slug: "a", forename: "A", surname: "Aa", works: ["a/w"] }],
        works: {
          "a/w": {
            authorSlugs: ["a"],
            hostSlug: "a",
            slug: "w",
            title: "W",
            breadcrumb: "W",
            imported: true,
            firstPublished: 1700,
            canonicalSlug: "1700",
            standalone: true,
            dir: "data/works/a/w",
            editions: [{
              authorSlugs: ["a"],
              workSlug: "w",
              slug: "1700",
              title: "W",
              breadcrumb: "W",
              imported: true,
              published: [1700],
              docKey: "a/w/1700",
              source: "data/works/a/w/1700.mit",
            }],
          },
        },
        warnings: [],
      }),
    readDocument: () =>
      Promise.resolve({
        id: "A.W.1700",
        blocks: [],
        children: [{ id: "A.W.1700.1", blocks: [], children: [] }],
      }),
  };
  const { catalog, warnings } = await loadCatalog(reader, "/corpus");
  assertEquals(warnings, []);
  const work = catalog.byAuthor.get("a")!.works[0];
  assertEquals(work.editions[0].document.children[0].id, "A.W.1700.1");
  assertEquals(
    catalog.sources.get(work.editions[0].document),
    "data/works/a/w/1700.mit",
  );
});

Deno.test("the first open builds the cache, a second reuses it", async () => {
  const harness = memoryHarness();
  await openComputer(harness.io, PATHS);
  assertEquals(harness.state.builds, 1);
  // unchanged corpus: the artefacts are fresh, so no rebuild
  await openComputer(harness.io, PATHS);
  assertEquals(harness.state.builds, 1);
});

Deno.test("a changed corpus is rebuilt", async () => {
  const harness = memoryHarness();
  await openComputer(harness.io, PATHS);
  assertEquals(harness.state.builds, 1);
  // add a corpus file: the scan's file count changes, so the cache is stale
  harness.files[`${CORPUS_ROOT}/data/authors/extra.mit`] =
    `# extra\n\n[metadata]\nforename = "Ex"\nsurname = "Tra"\n`;
  const { computer } = await openComputer(harness.io, PATHS);
  assertEquals(harness.state.builds, 2);
  // the rebuild used the fresh corpus
  const catalog = await computer.catalog();
  assert(catalog.authors.some((a) => a.slug === "extra"));
});

Deno.test("a reopened computer answers identically (codec round-trips)", async () => {
  const harness = memoryHarness(testCorpus());
  const first = (await openComputer(harness.io, PATHS)).computer;
  const firstCatalog = await first.catalog();
  const firstSearch = await first.search({ q: "liberty of the press" });
  // reopen from the cached artefacts (no rebuild) and compare
  const second = (await openComputer(harness.io, PATHS)).computer;
  assertEquals(harness.state.builds, 1);
  assertEquals(await second.catalog(), firstCatalog);
  assertEquals(await second.search({ q: "liberty of the press" }), firstSearch);
});
