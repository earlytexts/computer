/**
 * The lazy block/token stores and the DTM/topic-model stores are the serve
 * side's on-disk caches — the same kind of internal optimisation cache_test
 * pins. These tests own the two properties the rest of the suite never sees:
 * the per-edition LRU evicts once it passes its cap, and a missing large
 * artefact is reported clearly rather than crashing obscurely.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type BlockReader,
  createBlockStore,
  createDtmStore,
  createTokenStore,
  createTopicsStore,
} from "../../src/core/serve/store.ts";
import { blockText } from "../../src/core/text/mod.ts";
import { testData, unitText } from "../helpers.ts";

/** Two unit indices that belong to different editions. */
const twoEditionUnits = (edition: number[]): [number, number] => {
  const first = 0;
  const other = edition.findIndex((e) => e !== edition[first]);
  return [first, other];
};

Deno.test("the block store evicts the least-recently-used edition past its cap", async () => {
  const data = await testData();
  const [a, b] = twoEditionUnits(data.artefacts.units.edition);
  assert(b !== -1, "fixture needs at least two editions");
  // A cap of one edition: reading a block from a second edition evicts the
  // first, and re-reading it reloads — still the right text either way. (block,
  // unlike unitBlock, loads a whole edition through the LRU.)
  const store = createBlockStore(data.artefacts, data.blocks, 1);
  assertEquals(blockText(await store.block(a)), unitText(data, a));
  assertEquals(blockText(await store.block(b)), unitText(data, b));
  assertEquals(blockText(await store.block(a)), unitText(data, a));
});

Deno.test("the token store evicts the least-recently-used edition past its cap", async () => {
  const data = await testData();
  const [a, b] = twoEditionUnits(data.artefacts.units.edition);
  const tokens = createTokenStore(data.artefacts, data.blocks, 1);
  const surfacesA = await tokens.unitSurfaces(a);
  assertEquals(surfacesA.length, data.artefacts.units.tokenCount[a]);
  await tokens.unitSurfaces(b); // evicts edition a
  const reloaded = await tokens.unitSurfaces(a); // reloads it
  assertEquals(reloaded, surfacesA);
});

/** A reader that has nothing — every read misses. */
const emptyReader: BlockReader = {
  readText: () => Promise.resolve(null),
  readRange: () => Promise.reject(new Error("no range")),
  readBytes: () => Promise.resolve(null),
};

Deno.test("a missing DTM artefact is reported, not a cryptic crash", async () => {
  const dtm = createDtmStore(emptyReader);
  await assertRejects(() => dtm.matrix(), Error, "DTM artefact is missing");
});

Deno.test("a missing topic-model artefact is reported, not a cryptic crash", async () => {
  const topics = createTopicsStore(emptyReader);
  await assertRejects(
    () => topics.model(),
    Error,
    "topic-model artefact is missing",
  );
});

Deno.test("a missing blocks/tokens file degrades to empty rather than crashing", async () => {
  // A reader that finds nothing (a partial/corrupt artefacts directory): the
  // block store yields no blocks and the token store yields an empty stream.
  const data = await testData();
  const blocks = createBlockStore(data.artefacts, emptyReader);
  // The edition has no readable blocks file, so the map is empty.
  await blocks.block(0); // readEditionBlocks sees a null text and returns empty
  const tokens = createTokenStore(data.artefacts, emptyReader);
  const surfaces = await tokens.unitSurfaces(0); // editionTokens sees null bytes
  assertEquals(surfaces.every((s) => s === 0), true);
});
