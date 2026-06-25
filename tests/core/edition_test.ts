/**
 * computer.edition / computer.fullText — addressing a work's canonical edition
 * or a named one, composite works resolving their borrowed children, the full
 * text carrying every section's blocks, and not-found.
 */

import { assert, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";

Deno.test("edition defaults to the work's canonical printing", async () => {
  const computer = await testComputer();
  const edition = await computer.edition("test", "tw");
  assertEquals(edition?.authors.map((a) => a.slug), ["test"]);
  assertEquals(edition?.edition.slug, "1760"); // canonical
  assert((edition?.blocks.length ?? 0) > 0);
  assertEquals(edition?.sections.map((s) => s.slug), ["1", "2"]);
  assert(edition?.sections.every((s) => s.imported));
  assertEquals(edition?.work.editions.length, 2); // for the edition strip
});

Deno.test("an explicit edition slug overrides the canonical default", async () => {
  const computer = await testComputer();
  const edition = await computer.edition("test", "tw", "1750");
  assertEquals(edition?.edition.slug, "1750");
});

Deno.test("a composite edition resolves cross-work children in order", async () => {
  const computer = await testComputer();
  // comp borrows tw's 1750 text via an angle-bracket placeholder, then adds its
  // own inline section — the two mix in file order.
  const edition = await computer.edition("test", "comp");
  assertEquals(edition?.sections.map((s) => s.slug), ["test-tw-1750", "in"]);
  // its scalar copytext was coerced to a one-element list.
  assertEquals(edition?.edition.copytext, ["1750"]);
});

Deno.test("full text includes every section's blocks", async () => {
  const computer = await testComputer();
  const full = await computer.fullText("test", "tw");
  assertEquals(full?.sections.length, 2);
  assert(full?.sections.every((s) => s.blocks.length > 0));
});

Deno.test("an unknown author, work, or edition resolves to undefined", async () => {
  const computer = await testComputer();
  assertEquals(await computer.edition("nope", "tw"), undefined);
  assertEquals(await computer.edition("test", "nope"), undefined);
  assertEquals(await computer.edition("test", "tw", "1234"), undefined);
  assertEquals(await computer.edition("test", "tw", "main"), undefined);
  assertEquals(await computer.edition("other", "tw"), undefined); // wrong author
});
