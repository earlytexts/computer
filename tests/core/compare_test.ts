/**
 * computer.compare / computer.compareSection — aligning two editions' section
 * lists, and the word-level Markit diff of one section (insertions for text only
 * in A, deletions for text only in B), plus not-found.
 */

import { assert, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";
import { ofType } from "../markit.ts";

Deno.test("compare aligns the two editions' sections", async () => {
  const computer = await testComputer();
  const compared = await computer.compare("test", "tw", "1750", "1760");
  assertEquals(compared?.rows.map((r) => r.key), ["1", "3", "2"]);
  const shared = compared!.rows[0];
  assert(shared.pathA !== undefined && shared.pathB !== undefined);
  assertEquals(compared!.rows[1].pathB, undefined); // 3 only in 1750
  assertEquals(compared!.rows[2].pathA, undefined); // 2 only in 1760
});

Deno.test("compare of a section is a word-level Markit diff", async () => {
  const computer = await testComputer();
  const compared = await computer.compareSection(
    "test",
    "tw",
    "1750",
    "1760",
    ["1"],
  );
  assertEquals(compared?.title, "Section 1");
  assertEquals(compared?.version, "edited");
  assertEquals(compared?.aPath, ["1"]);
  assertEquals(compared?.bPath, ["1"]);
  // a→1750, b→1760: A is the primary edition, so words only in 1750 are
  // insertions and those only in 1760 are deletions.
  const deletions = (compared?.blocks ?? []).flatMap((b) =>
    ofType(b.content, "deletion")
  );
  const insertions = (compared?.blocks ?? []).flatMap((b) =>
    ofType(b.content, "insertion")
  );
  assert(insertions.some((t) => t.includes("betwixt")));
  assert(deletions.some((t) => t.includes("between")));
  assert(insertions.some((t) => t.includes("encrease")));
  assert(deletions.some((t) => t.includes("increase")));
  // a paragraph only in 1750 is wrapped whole as an insertion
  assert(insertions.some((t) => t.includes("only in the seventeen-fifty")));
});

Deno.test("comparing an edition with itself resolves to undefined", async () => {
  const computer = await testComputer();
  assertEquals(
    await computer.compare("test", "tw", "1750", "1750"),
    undefined,
  );
});

Deno.test("comparing an unknown section resolves to undefined", async () => {
  const computer = await testComputer();
  assertEquals(
    await computer.compareSection("test", "tw", "1750", "1760", ["99"]),
    undefined,
  );
});
