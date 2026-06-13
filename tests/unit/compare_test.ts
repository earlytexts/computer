import { assert, assertEquals, assertExists } from "@std/assert";
import { findWork, sectionTree } from "../../src/lib/catalog.ts";
import {
  alignSections,
  findSectionByKey,
  sectionKey,
} from "../../src/lib/compare.ts";
import { testData } from "../helpers.ts";

Deno.test("sectionKey strips edition-year suffixes", () => {
  assertEquals(sectionKey("test-tw-1750"), "test-tw");
  assertEquals(sectionKey("1"), "1");
  assertEquals(sectionKey("dt"), "dt");
});

Deno.test("alignSections pairs shared sections and flags one-sided ones", async () => {
  const { catalog } = await testData();
  const tw = findWork(catalog, "test", "tw")!;
  const a = tw.editions.find((e) => e.slug === "1750")!;
  const b = tw.editions.find((e) => e.slug === "1760")!;
  const rows = alignSections(sectionTree(a.document), sectionTree(b.document));
  assertEquals(rows.map((row) => row.key), ["1", "3", "2"]);
  const shared = rows.find((row) => row.key === "1")!;
  assert(shared.a !== undefined && shared.b !== undefined);
  const onlyA = rows.find((row) => row.key === "3")!;
  assert(onlyA.a !== undefined && onlyA.b === undefined);
  const onlyB = rows.find((row) => row.key === "2")!;
  assert(onlyB.a === undefined && onlyB.b !== undefined);
});

Deno.test("findSectionByKey finds matching sections across editions", async () => {
  const { catalog } = await testData();
  const tw = findWork(catalog, "test", "tw")!;
  for (const edition of tw.editions) {
    const found = findSectionByKey(sectionTree(edition.document), ["1"]);
    assertExists(found, `section 1 missing in ${edition.slug}`);
    assertEquals(found.title, "Section 1");
  }
});
