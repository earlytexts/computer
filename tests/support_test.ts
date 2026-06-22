/**
 * The in-memory test infrastructure (the corpus FS and the artefact-store block
 * reader in helpers.ts) stands in for the real filesystem, so it must honour the
 * same "absent → null" contract the production adapters do. These tiny checks
 * pin that contract directly, since the behavioural suites only ever read files
 * that exist.
 */

import { assertEquals } from "@std/assert";
import { memoryCorpus } from "./corpus.ts";
import { memoryHarness } from "./helpers.ts";

Deno.test("the in-memory corpus FS returns null for a file it does not have", async () => {
  const fs = memoryCorpus({ "/corpus/authors/a.mit": "# a\n" });
  assertEquals(await fs.readFile("/corpus/authors/missing.mit"), null);
});

Deno.test("the in-memory block reader returns null for files it does not have", async () => {
  const reader = memoryHarness().io.blockReader("memory");
  assertEquals(await reader.readText("nope/blocks.jsonl"), null);
  assertEquals(await reader.readBytes("nope/tokens.bin"), null);
});
