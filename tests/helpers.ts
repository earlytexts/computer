import { type Catalog, loadCatalog } from "../src/lib/catalog.ts";
import { buildIndex, type SearchIndex } from "../src/lib/search.ts";

export const fixtureCorpus = decodeURIComponent(
  new URL("fixtures/corpus", import.meta.url).pathname,
);

type TestData = {
  catalog: Catalog;
  searchIndex: SearchIndex;
  warnings: string[];
};

let loaded: Promise<TestData> | undefined;

/** Load the fixture corpus and its search index once per test process. */
export const testData = (): Promise<TestData> =>
  loaded ??= (async () => {
    const { catalog, warnings } = await loadCatalog(fixtureCorpus);
    return { catalog, searchIndex: buildIndex(catalog), warnings };
  })();
