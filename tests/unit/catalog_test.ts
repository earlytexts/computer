import { assert, assertEquals, assertExists } from "@std/assert";
import {
  findSection,
  flattenSections,
  sectionTree,
} from "../../src/lib/catalog.ts";
import { testData } from "../helpers.ts";

Deno.test("catalog loads file works, directory works, and composites", async () => {
  const { catalog } = await testData();
  for (const slug of ["solo", "tw", "comp"]) {
    assertExists(catalog.bySlug.get(slug), `work "${slug}" missing`);
  }
});

Deno.test("fixture corpus compiles without warnings", async () => {
  const { warnings } = await testData();
  assertEquals(warnings, []);
});

Deno.test("multi-edition works have the main edition first, then dated ones", async () => {
  const { catalog } = await testData();
  const tw = catalog.bySlug.get("tw")!;
  assertEquals(tw.editions.map((e) => e.slug), ["main", "1750", "1760"]);
  assert(tw.editions[0].isMain);
  assertEquals(tw.editions[0].title, "A Test Work");
  assertEquals(tw.editions[1].published, [1750]);
});

Deno.test("single-file works have exactly one edition", async () => {
  const { catalog } = await testData();
  const solo = catalog.bySlug.get("solo")!;
  assertEquals(solo.editions.length, 1);
  assertEquals(solo.editions[0].slug, "main");
});

Deno.test("section tree is navigable to nested sections", async () => {
  const { catalog } = await testData();
  const solo = catalog.bySlug.get("solo")!.editions[0];
  const tree = sectionTree(solo.document);
  assertEquals(tree.length, 1);
  assertEquals(tree[0].children.map((s) => s.slug), ["1", "2"]);
  const flat = flattenSections(tree);
  assertEquals(flat.map((s) => s.path.join("/")), ["1", "1/1", "1/2"]);
  const found = findSection(solo.document, ["1", "2"]);
  assertExists(found);
  assertEquals(found.title, "Part 1, Section 2");
});

Deno.test("composite editions resolve cross-work children in order", async () => {
  const { catalog } = await testData();
  const comp = catalog.bySlug.get("comp")!;
  const sections = sectionTree(comp.editions[0].document);
  assertEquals(sections.map((s) => s.slug), ["test-tw-1750", "in"]);
});

Deno.test("shared documents are attributed to their own work", async () => {
  const { catalog } = await testData();
  const comp = catalog.bySlug.get("comp")!;
  const borrowed = sectionTree(comp.editions[0].document)
    .find((s) => s.slug === "test-tw-1750")!;
  const source = catalog.sources.get(borrowed.doc);
  assertExists(source);
  assert(source.includes("/tw/"), `expected a tw source, got ${source}`);
});
