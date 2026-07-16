import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ARTEFACT_FILES,
  type Manifest,
  parseArtefacts,
} from "../src/core/artefacts.ts";
import { createBlockStore } from "../src/core/serve/store.ts";
import { denoIo } from "../src/core/io.ts";
import { extractText } from "../src/core/text/mod.ts";
import { testData, unitText } from "./helpers.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
      assertEquals(
        extractText(await store.unitBlock(i)).text,
        unitText(data, i),
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readManifest returns null when the directory is absent", async () => {
  assertEquals(await denoIo.readManifest("/no/such/computer-dir"), null);
});

Deno.test("the corpus fingerprint tracks content, not mtime", async () => {
  // The freshness probe must survive a deploy snapshot that does not preserve
  // mtimes: identical content (touched to a new mtime) stays fresh; changed
  // content goes stale. So it fingerprints the catalogue's bytes, not its stat.
  const base = await Deno.makeTempDir({ prefix: "computer-io-" });
  const catalogueDir = `${base}/catalogue`;
  const path = `${catalogueDir}/catalogue.json`;
  try {
    await Deno.mkdir(catalogueDir, { recursive: true });
    await Deno.writeTextFile(path, '{"authors":[]}');
    const first = await denoIo.scanCorpus(base);

    // Rewrite the same content with a later mtime: the fingerprint is unchanged.
    await Deno.writeTextFile(path, '{"authors":[]}');
    await Deno.utime(path, new Date(), new Date(Date.now() + 60_000));
    assertEquals(await denoIo.scanCorpus(base), first);

    // Different content: the fingerprint changes.
    await Deno.writeTextFile(path, '{"authors":["hume"]}');
    assert((await denoIo.scanCorpus(base)).modified !== first.modified);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("the catalogue reader returns null when the corpus was not built", async () => {
  assertEquals(await denoIo.readCatalogue("/no/such/corpus"), null);
  assertEquals(await denoIo.readDocument("/no/such/corpus", "a/w/1700"), null);
  // The freshness probe degrades to an empty fingerprint rather than throwing.
  assertEquals(await denoIo.scanCorpus("/no/such/corpus"), {
    files: 0,
    modified: 0,
  });
});

Deno.test("writeArtefacts creates a fresh directory that does not yet exist", async () => {
  const data = await testData();
  const base = await Deno.makeTempDir({ prefix: "computer-io-" });
  const dir = `${base}/not/created/yet`; // readDir on it will throw → treated empty
  try {
    await denoIo.writeArtefacts(dir, data.files);
    assert((await denoIo.readManifest(dir)) !== null);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("the block reader returns null for missing block and token files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "computer-io-" });
  try {
    const reader = denoIo.blockReader(dir);
    assertEquals(await reader.readText("absent/blocks.jsonl"), null);
    assertEquals(await reader.readBytes("absent/tokens.bin"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRange past the end of a file is an error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "computer-io-" });
  try {
    await Deno.writeFile(`${dir}/small.bin`, new Uint8Array([1, 2, 3]));
    const reader = denoIo.blockReader(dir);
    // Reading the three bytes back is fine.
    assertEquals(
      await reader.readRange("small.bin", 0, 3),
      new Uint8Array([1, 2, 3]),
    );
    // Asking for more than the file holds hits EOF before the length is met.
    await assertRejects(
      () => reader.readRange("small.bin", 0, 9),
      Error,
      "unexpected EOF",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseArtefacts rejects artefacts from a different pipeline version", async () => {
  const data = await testData();
  const files = new Map(data.files);
  const manifest = JSON.parse(
    decoder.decode(files.get(ARTEFACT_FILES.manifest)),
  ) as Manifest;
  const tampered = {
    ...manifest,
    pipelineVersion: manifest.pipelineVersion + 1,
  };
  files.set(ARTEFACT_FILES.manifest, encoder.encode(JSON.stringify(tampered)));
  assertThrowsVersion(() => parseArtefacts(files));
});

const assertThrowsVersion = (fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("pipeline"));
    return;
  }
  throw new Error("expected a pipeline-version mismatch to throw");
};

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
