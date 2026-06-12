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

// The server runs entirely from the on-disk artefacts; the corpus is compiled
// into memory only when the artefacts are stale and need rebuilding.
const t0 = performance.now();
const scan = await scanCorpus(corpusDir);
if (await artefactsFresh(artefactsDir, scan)) {
  console.log(`Artefacts: ${artefactsDir} (fresh)`);
} else {
  console.log(`Artefacts: ${artefactsDir} (stale or missing; rebuilding)`);
  const { catalog, warnings } = await loadCatalog(corpusDir);
  await writeArtefacts(artefactsDir, buildArtefacts(catalog, warnings, scan));
}
const artefacts = await loadServeArtefacts(artefactsDir);
const t1 = performance.now();

const { stats, warnings } = artefacts.manifest;
console.log(
  `Corpus: ${corpusDir}\n` +
    `Ready in ${Math.round(t1 - t0)}ms: ` +
    `${stats.works} works by ${stats.authors} authors ` +
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
Deno.serve({ port }, createHandler({ artefacts, limiter }));
