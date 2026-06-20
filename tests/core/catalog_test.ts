/**
 * computer.catalog — the Author → Work → Edition tree: ordering, canonical
 * slugs, the imported flag, and which edition slugs are exposed.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { testComputer } from "../helpers.ts";

Deno.test("catalog lists authors ordered by first publication", async () => {
  const computer = await testComputer();
  const catalog = await computer.catalog();
  // other (1730) before test (1740)
  assertEquals(catalog.authors.map((a) => a.slug), ["other", "test"]);
  const test = catalog.authors.find((a) => a.slug === "test");
  assertExists(test);
  assertEquals(test.surname, "Test");
});

Deno.test("works are ordered chronologically within an author", async () => {
  const computer = await testComputer();
  const catalog = await computer.catalog();
  const test = catalog.authors.find((a) => a.slug === "test")!;
  // solo 1740, tw 1750, comp 1755
  assertEquals(test.works.map((w) => w.slug), ["solo", "tw", "comp"]);
});

Deno.test("an edition's metadata carries its slugs and canonical default", async () => {
  const computer = await testComputer();
  const catalog = await computer.catalog();
  const tw = catalog.authors.find((a) => a.slug === "test")!
    .works.find((w) => w.slug === "tw")!;
  assertEquals(tw.editions.map((e) => e.slug), ["1750", "1760"]);
  assertEquals(tw.canonicalSlug, "1760");
  assert(tw.imported);
});

Deno.test("an unimported work is flagged as a stub", async () => {
  const computer = await testComputer();
  const catalog = await computer.catalog();
  const stub = catalog.authors.find((a) => a.slug === "other")!
    .works.find((w) => w.slug === "stub")!;
  assertExists(stub);
  assertEquals(stub.imported, false);
});

Deno.test("editionSlugs lists real editions but not the retained main text", async () => {
  const computer = await testComputer();
  const catalog = await computer.catalog();
  assert(catalog.editionSlugs.includes("1760"));
  assert(catalog.editionSlugs.includes("1750"));
  assert(!catalog.editionSlugs.includes("main"));
});
