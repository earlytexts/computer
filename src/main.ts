import { loadCatalog } from "./lib/catalog.ts";
import { buildIndex } from "./lib/search.ts";
import { createHandler } from "./server.ts";
import { createRateLimiter } from "./ratelimit.ts";

const env = (name: string): string | undefined => {
  const value = Deno.env.get(name);
  return value === undefined || value === "" ? undefined : value;
};

const corpusDir = env("CORPUS_DIR") ??
  decodeURIComponent(new URL("../../corpus", import.meta.url).pathname);

const t0 = performance.now();
const { catalog, warnings } = await loadCatalog(corpusDir);
const t1 = performance.now();
const searchIndex = buildIndex(catalog);
const t2 = performance.now();

console.log(
  `Corpus: ${corpusDir}\n` +
    `Loaded ${catalog.works.length} works in ${Math.round(t1 - t0)}ms; ` +
    `indexed ${searchIndex.units.length} blocks ` +
    `(${searchIndex.tokens.length} distinct tokens) in ${
      Math.round(t2 - t1)
    }ms.`,
);
if (warnings.length > 0) {
  console.warn(`${warnings.length} corpus warnings:`);
  for (const warning of warnings) console.warn(`  - ${warning}`);
}

const limiter = createRateLimiter({
  ratePerSecond: Number(env("RATE_LIMIT_RPS") ?? 20),
  burst: Number(env("RATE_LIMIT_BURST") ?? 100),
});

const port = Number(env("PORT") ?? 8420);
Deno.serve({ port }, createHandler({ catalog, searchIndex, limiter }));
