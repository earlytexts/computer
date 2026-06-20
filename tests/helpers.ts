import { buildCatalog, type Catalog } from "../src/lib/build/catalog.ts";
import {
  type ArtefactFiles,
  type Artefacts,
  type CorpusScan,
  parseArtefacts,
  serializeArtefacts,
  type ServeArtefacts,
} from "../src/lib/artefacts.ts";
import { buildArtefacts } from "../src/lib/build/builder.ts";
import {
  type BlockReader,
  type BlockStore,
  createBlockStore,
} from "../src/lib/serve/store.ts";
import { denoIo } from "../src/lib/io.ts";

export const fixtureCorpus = decodeURIComponent(
  new URL("fixtures/corpus", import.meta.url).pathname,
);

export type TestData = {
  catalog: Catalog;
  /** In-memory build output (includes text blobs and token streams). */
  built: Artefacts;
  /** The serialized artefact files (relpath -> bytes), as written to disk. */
  files: ArtefactFiles;
  /** The artefacts parsed back into served state (no disk round-trip). */
  artefacts: ServeArtefacts;
  /** A block reader over `files`, and a store built on it. */
  blocks: BlockReader;
  store: BlockStore;
  scan: CorpusScan;
  warnings: string[];
};

const decoder = new TextDecoder();

/** A BlockReader backed by an in-memory file map (mirrors io.blockReader). */
const mapBlockReader = (files: ArtefactFiles): BlockReader => ({
  readText: (relPath) => {
    const bytes = files.get(relPath);
    return Promise.resolve(bytes === undefined ? null : decoder.decode(bytes));
  },
  readRange: (relPath, offset, length) => {
    const bytes = files.get(relPath);
    if (bytes === undefined) throw new Error(`no file ${relPath}`);
    return Promise.resolve(bytes.subarray(offset, offset + length));
  },
});

let loaded: Promise<TestData> | undefined;

/** Build the fixture corpus's artefacts once per test process. */
export const testData = (): Promise<TestData> =>
  loaded ??= (async () => {
    const { catalog, warnings } = await buildCatalog(
      denoIo.corpus,
      fixtureCorpus,
    );
    const scan = await denoIo.scanCorpus(fixtureCorpus);
    const built = buildArtefacts(catalog, warnings, scan);
    // Round-trip through the codec, all in memory — no temp directory.
    const files = serializeArtefacts(built);
    const artefacts = parseArtefacts(files);
    const blocks = mapBlockReader(files);
    const store = createBlockStore(artefacts, blocks);
    return { catalog, built, files, artefacts, blocks, store, scan, warnings };
  })();

/** A unit's extracted text, sliced from the built text blob. */
export const unitText = (data: TestData, unitIndex: number): string => {
  const { units, manifest } = data.artefacts;
  const ref = manifest.editions[units.edition[unitIndex]];
  const edition = data.built.editions.find((e) =>
    e.author === ref.author && e.work === ref.work && e.edition === ref.edition
  )!;
  return edition.text.slice(
    units.blobOffset[unitIndex],
    units.blobOffset[unitIndex] + units.blobLength[unitIndex],
  );
};
