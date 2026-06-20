import { assert, assertEquals, assertRejects } from "@std/assert";
import { parseArtefacts } from "../src/core/artefacts.ts";
import { createBlockStore } from "../src/core/serve/store.ts";
import { denoIo } from "../src/core/io.ts";
import { blockText } from "../src/core/text/mod.ts";
import { testData, unitText } from "./helpers.ts";

// The io adapter is the only module that touches the filesystem, so it is
// exercised directly here: serialize -> write -> read -> parse, plus the
// per-edition byte-range reads, through a real temp directory.
Deno.test("io round-trips artefacts through a directory", async () => {
  const data = await testData();
  const dir = await Deno.makeTempDir({ prefix: "computer-io-" });
  try {
    await denoIo.writeArtefacts(dir, data.files);

    const manifest = await denoIo.readManifest(dir);
    assertEquals(manifest, data.artefacts.manifest);

    const artefacts = parseArtefacts(await denoIo.readArtefacts(dir));
    assertEquals(artefacts.manifest, data.artefacts.manifest);
    assertEquals(artefacts.vocab, data.artefacts.vocab);
    assertEquals(artefacts.units, data.artefacts.units);

    // Block content reads back from the per-edition files by byte range.
    const store = createBlockStore(artefacts, denoIo.blockReader(dir));
    for (let i = 0; i < artefacts.units.edition.length; i++) {
      assertEquals(blockText(await store.unitBlock(i)), unitText(data, i));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readManifest returns null when the directory is absent", async () => {
  assertEquals(await denoIo.readManifest("/no/such/computer-dir"), null);
});

Deno.test("writeArtefacts refuses to clobber a non-artefacts directory", async () => {
  const data = await testData();
  const dir = await Deno.makeTempDir({ prefix: "computer-io-" });
  try {
    await Deno.writeTextFile(`${dir}/keep.txt`, "precious");
    await assertRejects(() => denoIo.writeArtefacts(dir, data.files));
    // the stray file is untouched
    assertEquals(await Deno.readTextFile(`${dir}/keep.txt`), "precious");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an artefacts directory is replaced in place", async () => {
  const data = await testData();
  const dir = await Deno.makeTempDir({ prefix: "computer-io-" });
  try {
    await denoIo.writeArtefacts(dir, data.files);
    // a second write (the dir now has a manifest) is allowed and succeeds
    await denoIo.writeArtefacts(dir, data.files);
    assert((await denoIo.readManifest(dir)) !== null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
