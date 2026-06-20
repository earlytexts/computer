/**
 * computer.section / computer.sectionFullText — a section with its navigation
 * and cross-edition compare links, recursive full text, the imported flag,
 * borrowed sections, editorial-version resolution, and not-found.
 */

import { assert, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";
import { ofType, textOf } from "../markit.ts";

Deno.test("a section comes with navigation and compare links", async () => {
  const computer = await testComputer();
  const section = await computer.section("test", "tw", undefined, ["1"]);
  assertEquals(section?.edition.slug, "1760"); // canonical
  assertEquals(section?.section.title, "Section 1");
  assert((section?.section.blocks.length ?? 0) > 0);
  assertEquals(section?.prev, undefined);
  assertEquals(section?.next?.path, ["2"]);
  // the other edition (1750) also has section 1
  assertEquals(section?.compareEditions.map((e) => e.slug), ["1750"]);
  assertEquals(section?.compareEditions[0].path, ["1"]); // its path in 1750
});

Deno.test("a section unique to one edition offers no comparisons", async () => {
  const computer = await testComputer();
  const section = await computer.section("test", "tw", "1750", ["3"]);
  assertEquals(section?.compareEditions, []);
});

Deno.test("a stub section reports imported = false", async () => {
  const computer = await testComputer();
  const section = await computer.section("test", "solo", undefined, ["2"]);
  assertEquals(section?.section.imported, false);
});

Deno.test("borrowed section text is reachable through the composite", async () => {
  const computer = await testComputer();
  const borrowed = await computer.sectionFullText(
    "test",
    "comp",
    undefined,
    ["test-tw-1750"],
  );
  assert((borrowed?.section.blocks.length ?? 0) > 0);
});

Deno.test("section full text returns all descendant blocks in order", async () => {
  const computer = await testComputer();
  // solo § 1 has two subsections; full text loads them recursively.
  const full = await computer.sectionFullText("test", "solo", undefined, ["1"]);
  assertEquals(full?.edition.slug, "1740");
  assertEquals(full?.section.path, ["1"]);
  assertEquals(full?.section.title, "Part 1");
  assert((full?.section.blocks.length ?? 0) > 0);
  assertEquals(full?.section.children.length, 2);
  assert(full?.section.children.every((c) => c.blocks.length > 0));
  // navigation is depth-first: section 1's next is its first child
  assertEquals(full?.prev, undefined);
  assertEquals(full?.next?.path, ["1", "1"]);
  assertEquals(full?.compareEditions, []);
  assertEquals(full?.ancestors, []);
});

Deno.test("section resolves editorial markup to the requested version", async () => {
  const computer = await testComputer();
  // solo §1.1 #2: "[-corrcted-][+corrected+] the text and [+also+] revised it."
  const path = ["1", "1"];

  const edited = await computer.section("test", "solo", undefined, path);
  assertEquals(edited?.version, "edited");
  const editedText = (edited?.section.blocks ?? []).map((b) =>
    textOf(b.content)
  )
    .join(" ");
  assert(editedText.includes("corrected the text and also revised"));
  assert(!editedText.includes("corrcted"));

  const original = await computer.section(
    "test",
    "solo",
    undefined,
    path,
    "original",
  );
  assertEquals(original?.version, "original");
  const originalText = (original?.section.blocks ?? [])
    .map((b) => textOf(b.content)).join(" ");
  assert(originalText.includes("corrcted the text"));
  assert(!originalText.includes("also"));

  const both = await computer.section("test", "solo", undefined, path, "both");
  assertEquals(both?.version, "both");
  const ins = (both?.section.blocks ?? []).flatMap((b) =>
    ofType(b.content, "insertion")
  );
  const del = (both?.section.blocks ?? []).flatMap((b) =>
    ofType(b.content, "deletion")
  );
  assert(ins.some((t) => t.includes("corrected")));
  assert(del.some((t) => t.includes("corrcted")));
});

Deno.test("an unknown section resolves to undefined", async () => {
  const computer = await testComputer();
  assertEquals(
    await computer.section("test", "tw", undefined, ["99"]),
    undefined,
  );
  assertEquals(
    await computer.sectionFullText("test", "solo", undefined, ["99"]),
    undefined,
  );
});
