/**
 * Test harness for the core seam. `openTestComputer` opens a `Computer` over an
 * in-memory corpus through the real `openComputer` front door (the same path the
 * entry points drive), keeping the artefact cache in memory — no temp directory,
 * no fixture files. The behavioural suite (tests/core/) drives this `Computer`;
 * the thin wiring tests (tests/wiring/) wrap it in the HTTP/MCP servers.
 *
 * `testData` exposes the lower-level artefact build (the in-memory `Artefacts`,
 * the serialized files, the loaded `ServeArtefacts`, a block store) for the two
 * tests that care about the cache itself — io_test (the disk adapter) and
 * cache_test (the freshness/codec optimisation).
 */

import {
  ARTEFACT_FILES,
  type ArtefactFiles,
  type Artefacts,
  type CorpusScan,
  type Manifest,
  type ServeArtefacts,
} from "../src/core/artefacts.ts";
import {
  type BlockReader,
  type BlockStore,
  createBlockStore,
} from "../src/core/serve/store.ts";
import { buildArtefactsToDisk, loadForServing } from "../src/core/pipeline.ts";
import { type Io, openComputer } from "../src/core/mod.ts";
import type { Computer } from "../src/types.ts";
import { CORPUS_ROOT, countMit, memoryCorpus, testCorpus } from "./corpus.ts";

const decoder = new TextDecoder();

/**
 * An `Io` over an in-memory corpus and an in-memory artefact store: a faithful
 * adapter (the codec round-trip and freshness probe both run) that touches no
 * disk. `state.builds` counts rebuilds, so cache_test can watch the freshness
 * logic; the corpus map is read live, so adding a file makes the scan stale.
 */
export type MemoryHarness = {
  io: Io;
  /** The (mutable) corpus map; mutate it to make the next open rebuild. */
  files: Record<string, string>;
  state: { builds: number };
  /** Every serialized artefact file written so far (tables + per-edition). */
  written: () => ArtefactFiles;
};

export const memoryHarness = (
  files: Record<string, string> = testCorpus(),
): MemoryHarness => {
  const corpus = memoryCorpus(files);
  let store: ArtefactFiles = new Map();
  const state = { builds: 0 };
  const io: Io = {
    corpus,
    scanCorpus: () => Promise.resolve({ files: countMit(files), modified: 0 }),
    readManifest: () => {
      const bytes = store.get(ARTEFACT_FILES.manifest);
      return Promise.resolve(
        bytes === undefined
          ? null
          : JSON.parse(decoder.decode(bytes)) as Manifest,
      );
    },
    readArtefacts: () => {
      const out: ArtefactFiles = new Map();
      for (const name of Object.values(ARTEFACT_FILES)) {
        const bytes = store.get(name);
        if (bytes !== undefined) out.set(name, bytes);
      }
      return Promise.resolve(out);
    },
    writeArtefacts: (_dir, written) => {
      store = new Map(written);
      state.builds++;
      return Promise.resolve();
    },
    blockReader: (): BlockReader => ({
      readText: (relPath) => {
        const bytes = store.get(relPath);
        return Promise.resolve(
          bytes === undefined ? null : decoder.decode(bytes),
        );
      },
      readRange: (relPath, offset, length) => {
        // unitBlock only ranges into editions that have a blocks file, so the
        // lookup always hits.
        const bytes = store.get(relPath)!;
        return Promise.resolve(bytes.subarray(offset, offset + length));
      },
      readBytes: (relPath) => Promise.resolve(store.get(relPath) ?? null),
    }),
  };
  return { io, files, state, written: () => store };
};

const PATHS = { corpusDir: CORPUS_ROOT, artefactsDir: "memory" };

/** Open a `Computer` over a corpus map (the shared one by default). */
export const openTestComputer = async (
  files: Record<string, string> = testCorpus(),
): Promise<{ computer: Computer; harness: MemoryHarness }> => {
  const harness = memoryHarness(files);
  const { computer } = await openComputer(harness.io, PATHS);
  return { computer, harness };
};

let shared: Promise<Computer> | undefined;

/** The shared `Computer` over the test corpus, opened once per test process. */
export const testComputer = (): Promise<Computer> =>
  shared ??= openTestComputer().then((r) => r.computer);

/* ----------------------- artefact-level fixtures ---------------------- */

export type TestData = {
  /** In-memory build output (includes text blobs and token streams). */
  built: Artefacts;
  /** The serialized artefact files (relpath → bytes), as written by the build. */
  files: ArtefactFiles;
  /** The artefacts loaded back into served state, as the server loads them. */
  artefacts: ServeArtefacts;
  /** A block reader over the built files, and a store built on it. */
  blocks: BlockReader;
  store: BlockStore;
  scan: CorpusScan;
  warnings: string[];
};

let loaded: Promise<TestData> | undefined;

/**
 * Build the test corpus's artefacts once per process, through the same pipeline
 * the entry points drive (`buildArtefactsToDisk` then `loadForServing`) over an
 * in-memory `Io` — codec round-trip and freshness path included, no temp dir.
 */
export const testData = (): Promise<TestData> =>
  loaded ??= (async () => {
    const { io, written } = memoryHarness();
    const built = await buildArtefactsToDisk(io, CORPUS_ROOT, "memory");
    const artefacts = await loadForServing(io, CORPUS_ROOT, "memory");
    const blocks = io.blockReader("memory");
    const store = createBlockStore(artefacts, blocks);
    const scan = await io.scanCorpus(CORPUS_ROOT);
    return {
      built,
      files: written(),
      artefacts,
      blocks,
      store,
      scan,
      warnings: built.manifest.warnings,
    };
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
