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
  assert(manifest.editionSlugs.includes("1760"));
  assert(manifest.editionSlugs.includes("1750"));
  assert(!manifest.editionSlugs.includes("main"));
});

Deno.test("the vocabulary is sorted and statistically coherent", async () => {
  const { artefacts } = await testData();
  const { surfaces, surfaceNorm, df, cf, norms } = artefacts.vocab;
  for (let i = 1; i < surfaces.length; i++) {
    assert(surfaces[i - 1] < surfaces[i]);
  }
  for (let i = 1; i < norms.length; i++) assert(norms[i - 1] < norms[i]);
  for (let i = 0; i < surfaces.length; i++) {
    // df can be 0 for surfaces that appear only in the original (pre-editorial)
    // text: they enter the vocabulary for original-text search but are absent
    // from the edited reading text, so cf = df = 0. cf >= df always holds.
    assert(cf[i] >= df[i]);
    assert(surfaceNorm[i] >= 0 && surfaceNorm[i] < norms.length);
  }
  // surfaces keep old spellings; norms unify them onto a stemmed bucket
  assert(surfaces.includes("encrease"));
  assert(surfaces.includes("betwixt"));
  assert(norms.includes("increas")); // encrease/increase(s) all land here
  assert(!norms.includes("encrease"));
});

Deno.test("postings are grouped by surface and within bounds", async () => {
  const { artefacts } = await testData();
  const { postings, overlayPostings, affectedUnits } = artefacts;
  const surfaces = artefacts.vocab.surfaces.length;
  const units = artefacts.units.edition.length;
  assertEquals(postings.offsets.length, surfaces + 1);
  assertEquals(overlayPostings.offsets.length, surfaces + 1);
  assertEquals(postings.offsets[surfaces] * 2, postings.pairs.length);
  assertEquals(
    overlayPostings.offsets[surfaces] * 2,
    overlayPostings.pairs.length,
  );
  const count = (p: typeof postings, id: number) =>
    p.offsets[id + 1] - p.offsets[id];
  for (let id = 0; id < surfaces; id++) {
    assert(postings.offsets[id] <= postings.offsets[id + 1]);
    // cf counts only edited-text (primary) occurrences; original-text overlay
    // postings are intentionally excluded so that downstream statistics reflect
    // the published reading text, not the manuscript layer.
    assertEquals(count(postings, id), artefacts.vocab.cf[id]);
    for (
      let i = postings.offsets[id] * 2;
      i < postings.offsets[id + 1] * 2;
      i += 2
    ) {
      assert(postings.pairs[i] < units);
    }
    // overlay pairs only ever address units that carry editorial markup
    for (
      let i = overlayPostings.offsets[id] * 2;
      i < overlayPostings.offsets[id + 1] * 2;
      i += 2
    ) {
      assert(affectedUnits.has(overlayPostings.pairs[i]));
    }
  }
  assert(affectedUnits.size > 0); // the fixture edits solo §1 #2
});

Deno.test(
  "original-only surfaces are indexed for search but excluded from df/cf",
  async () => {
    const { artefacts } = await testData();
    const { vocab, postings, overlayPostings } = artefacts;
    // "corrcted" is the original misspelling in solo §1 #2 (the fixture edits
    // it to "corrected"). It must enter the vocabulary so that an original-text
    // search can find it, but it must NOT contribute to df or cf — those counts
    // are grounded in the edited reading text only.
    const id = vocab.surfaces.indexOf("corrcted");
    assert(id >= 0, '"corrcted" must be in the vocabulary');
    assertEquals(vocab.df[id], 0);
    assertEquals(vocab.cf[id], 0);
    assertEquals(postings.offsets[id + 1] - postings.offsets[id], 0);
    assert(overlayPostings.offsets[id + 1] - overlayPostings.offsets[id] > 0);
  },
);

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
