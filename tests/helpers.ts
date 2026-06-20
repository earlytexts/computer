import { type Catalog, loadCatalog } from "../src/lib/build/catalog.ts";
import {
  type Artefacts,
  type CorpusScan,
  scanCorpus,
  type ServeArtefacts,
} from "../src/lib/artefacts.ts";
import { buildArtefacts, writeArtefacts } from "../src/lib/build/builder.ts";
import { loadServeArtefacts } from "../src/lib/serve/store.ts";

export const fixtureCorpus = decodeURIComponent(
  new URL("fixtures/corpus", import.meta.url).pathname,
);

export type TestData = {
  catalog: Catalog;
  /** In-memory build output (includes text blobs and token streams). */
  built: Artefacts;
  /** The same artefacts written to a temp dir and loaded back. */
  artefacts: ServeArtefacts;
  scan: CorpusScan;
  warnings: string[];
};

let loaded: Promise<TestData> | undefined;

/** Build the fixture corpus's artefacts once per test process. */
export const testData = (): Promise<TestData> =>
  loaded ??= (async () => {
    const { catalog, warnings } = await loadCatalog(fixtureCorpus);
    const scan = await scanCorpus(fixtureCorpus);
    const built = buildArtefacts(catalog, warnings, scan);
    const dir = await Deno.makeTempDir({ prefix: "computer-artefacts-" });
    await writeArtefacts(dir, built);
    const artefacts = await loadServeArtefacts(dir);
    return { catalog, built, artefacts, scan, warnings };
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
