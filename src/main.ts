import {
  artefactsFresh,
  buildArtefacts,
  loadServeArtefacts,
  scanCorpus,
  writeArtefacts,
} from "./lib/artefacts.ts";
import { loadCatalog } from "./lib/catalog.ts";
import { createHandler } from "./server.ts";
import { createRateLimiter } from "./ratelimit.ts";

const env = (name: string): string | undefined => {
  const value = Deno.env.get(name);
  return value === undefined || value === "" ? undefined : value;
};

const corpusDir = env("CORPUS_DIR") ??
  decodeURIComponent(new URL("../../corpus", import.meta.url).pathname);
const artefactsDir = env("ARTEFACTS_DIR") ??
  decodeURIComponent(new URL("../artefacts", import.meta.url).pathname);

const t0 = performance.now();
const { catalog, warnings } = await loadCatalog(corpusDir);
const t1 = performance.now();

const scan = await scanCorpus(corpusDir);
if (await artefactsFresh(artefactsDir, scan)) {
  console.log(`Artefacts: ${artefactsDir} (fresh)`);
} else {
  console.log(`Artefacts: ${artefactsDir} (stale or missing; rebuilding)`);
  await writeArtefacts(artefactsDir, buildArtefacts(catalog, warnings, scan));
}
const artefacts = await loadServeArtefacts(artefactsDir);
const t2 = performance.now();

const { stats } = artefacts.manifest;
console.log(
  `Corpus: ${corpusDir}\n` +
    `Loaded ${stats.works} works by ${stats.authors} authors in ${
      Math.round(t1 - t0)
    }ms; ` +
    `search ready in ${Math.round(t2 - t1)}ms ` +
    `(${stats.units} blocks, ${stats.tokens} tokens, ` +
    `${stats.surfaces} surface forms).`,
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
Deno.serve({ port }, createHandler({ catalog, artefacts, limiter }));
