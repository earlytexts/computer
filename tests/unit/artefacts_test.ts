import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  artefactsFresh,
  loadServeArtefacts,
  PIPELINE_VERSION,
  readUnitBlock,
} from "../../src/lib/artefacts.ts";
import { blockText } from "../../src/lib/text.ts";
import { testData, unitText } from "../helpers.ts";

Deno.test("the manifest records the pipeline and the corpus", async () => {
  const { artefacts, scan } = await testData();
  const { manifest } = artefacts;
  assertEquals(manifest.pipelineVersion, PIPELINE_VERSION);
  assertEquals(manifest.corpus, scan);
  assertEquals(manifest.stats.authors, 2);
  assertEquals(manifest.stats.works, 4);
  assertEquals(manifest.stats.units, artefacts.units.edition.length);
  assert(manifest.editionSlugs.includes("main"));
  assert(manifest.editionSlugs.includes("1750"));
});

Deno.test("the vocabulary is sorted and statistically coherent", async () => {
  const { artefacts } = await testData();
  const { surfaces, surfaceNorm, df, cf, norms } = artefacts.vocab;
  for (let i = 1; i < surfaces.length; i++) {
    assert(surfaces[i - 1] < surfaces[i]);
  }
  for (let i = 1; i < norms.length; i++) assert(norms[i - 1] < norms[i]);
  for (let i = 0; i < surfaces.length; i++) {
    assert(df[i] >= 1 && cf[i] >= df[i]);
    assert(surfaceNorm[i] >= 0 && surfaceNorm[i] < norms.length);
  }
  // surfaces keep old spellings; norms unify them
  assert(surfaces.includes("encrease"));
  assert(surfaces.includes("betwixt"));
  assert(norms.includes("increase"));
  assert(!norms.includes("encrease"));
});

Deno.test("postings are grouped by surface and within bounds", async () => {
  const { artefacts } = await testData();
  const { offsets, pairs } = artefacts.postings;
  const surfaces = artefacts.vocab.surfaces.length;
  const units = artefacts.units.edition.length;
  assertEquals(offsets.length, surfaces + 1);
  assertEquals(offsets[surfaces] * 2, pairs.length);
  for (let id = 0; id < surfaces; id++) {
    assert(offsets[id] <= offsets[id + 1]);
    const count = offsets[id + 1] - offsets[id];
    assertEquals(count, artefacts.vocab.cf[id]);
    for (let i = offsets[id] * 2; i < offsets[id + 1] * 2; i += 2) {
      assert(pairs[i] < units);
    }
  }
});

Deno.test("blocks read back from disk match the text blob", async () => {
  const data = await testData();
  const { artefacts } = data;
  for (let i = 0; i < artefacts.units.edition.length; i++) {
    const block = await readUnitBlock(artefacts, i);
    assertEquals(blockText(block), unitText(data, i));
    assertEquals(
      artefacts.units.blockId[i],
      block.id.split(".").pop(),
    );
  }
});

Deno.test("token streams point at their surfaces in the blob", async () => {
  const { built } = await testData();
  const { vocab } = built;
  for (const edition of built.editions) {
    for (let i = 0; i < edition.tokens.length; i += 2) {
      const surface = vocab.surfaces[edition.tokens[i]];
      const offset = edition.tokens[i + 1];
      assertEquals(
        edition.text.slice(offset, offset + surface.length).toLowerCase(),
        surface,
      );
    }
  }
});

Deno.test("freshness tracks pipeline version and corpus fingerprint", async () => {
  const { artefacts, scan } = await testData();
  assert(await artefactsFresh(artefacts.dir, scan));
  assert(
    !(await artefactsFresh(artefacts.dir, { ...scan, files: scan.files + 1 })),
  );
  assert(
    !(await artefactsFresh(artefacts.dir, { ...scan, modified: Date.now() })),
  );
  assert(!(await artefactsFresh(artefacts.dir + "-nope", scan)));
  await assertRejects(() => loadServeArtefacts(artefacts.dir + "-nope"));
});
