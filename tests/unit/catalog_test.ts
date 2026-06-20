import { assert, assertEquals, assertExists } from "@std/assert";
import {
  findSection,
  findWork,
  flattenSections,
  sectionTree,
} from "../../src/lib/build/catalog.ts";
import { testData } from "../helpers.ts";

Deno.test("catalog loads authors with their works", async () => {
  const { catalog } = await testData();
  const test = catalog.byAuthor.get("test");
  assertExists(test);
  assertEquals(test.surname, "Test");
  assertEquals(test.birth, 1700);
  for (const slug of ["solo", "tw", "comp"]) {
    assertExists(findWork(catalog, "test", slug), `work "${slug}" missing`);
  }
});

Deno.test("authors are ordered by first publication year", async () => {
  const { catalog } = await testData();
  // Other published 1730, Test published 1740.
  assertEquals(catalog.authors.map((a) => a.slug), ["other", "test"]);
  assertEquals(catalog.authors[0].title, "Lady Other");
});

Deno.test("works are ordered chronologically within an author", async () => {
  const { catalog } = await testData();
  const works = catalog.byAuthor.get("test")!.works;
  // solo 1740, tw 1750, comp 1755.
  assertEquals(works.map((w) => w.slug), ["solo", "tw", "comp"]);
  assertEquals(works.map((w) => w.published[0]), [1740, 1750, 1755]);
});

Deno.test("fixture corpus compiles without warnings", async () => {
  const { warnings } = await testData();
  assertEquals(warnings, []);
});

Deno.test("works expose dated editions ascending, with a canonical slug", async () => {
  const { catalog } = await testData();
  const tw = findWork(catalog, "test", "tw")!;
  assertEquals(tw.editions.map((e) => e.slug), ["1750", "1760"]);
  assertEquals(tw.canonicalSlug, "1760");
  // Work identity comes from the stub, not from any one edition.
  assertEquals(tw.title, "A Test Work");
  assertEquals(tw.editions[0].published, [1750]);
});

Deno.test("the retained main.mit reading text is never an edition", async () => {
  const { catalog } = await testData();
  const tw = findWork(catalog, "test", "tw")!;
  assert(!tw.editions.some((e) => e.slug === "main"));
});

Deno.test("a single-edition work has one edition, canonical by default", async () => {
  const { catalog } = await testData();
  const solo = findWork(catalog, "test", "solo")!;
  assertEquals(solo.editions.length, 1);
  assertEquals(solo.editions[0].slug, "1740");
  assertEquals(solo.canonicalSlug, "1740");
});

Deno.test("stub works are catalogued but not imported", async () => {
  const { catalog } = await testData();
  const stub = findWork(catalog, "other", "stub")!;
  assertEquals(stub.imported, false);
  assertEquals(stub.title, "A Stub Treatise, Not Yet Transcribed");
});

Deno.test("section tree is navigable to nested sections", async () => {
  const { catalog } = await testData();
  const solo = findWork(catalog, "test", "solo")!.editions[0];
  const tree = sectionTree(solo.document);
  assertEquals(tree.length, 2);
  assertEquals(tree[0].children.map((s) => s.slug), ["1", "2"]);
  const flat = flattenSections(tree);
  assertEquals(flat.map((s) => s.path.join("/")), ["1", "1/1", "1/2", "2"]);
  const found = findSection(solo.document, ["1", "2"]);
  assertExists(found);
  assertEquals(found.title, "Part 1, Section 2");
});

Deno.test("sections inherit imported from their ancestors", async () => {
  const { catalog } = await testData();
  const solo = findWork(catalog, "test", "solo")!.editions[0];
  const tree = sectionTree(solo.document);
  // Part 1 and its sections inherit the root's imported = true...
  assertEquals(tree[0].imported, true);
  assert(tree[0].children.every((s) => s.imported));
  // ...while Part 2 overrides it.
  assertEquals(tree[1].imported, false);
});

Deno.test("composite editions resolve cross-work children in order", async () => {
  const { catalog } = await testData();
  const comp = findWork(catalog, "test", "comp")!;
  const sections = sectionTree(comp.editions[0].document);
  assertEquals(sections.map((s) => s.slug), ["test-tw-1750", "in"]);
});

Deno.test("shared documents are attributed to their own work", async () => {
  const { catalog } = await testData();
  const comp = findWork(catalog, "test", "comp")!;
  const borrowed = sectionTree(comp.editions[0].document)
    .find((s) => s.slug === "test-tw-1750")!;
  const source = catalog.sources.get(borrowed.doc);
  assertExists(source);
  assert(source.includes("/tw/"), `expected a tw source, got ${source}`);
});
