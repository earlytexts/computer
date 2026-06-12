/**
 * CLI entry point for the build pipeline: compile the corpus and write the
 * derived artefacts to disk (`deno task build`). The server does the same
 * on boot when its artefacts are stale, so running this is an optimisation
 * (fast deploys, CI checks), not a requirement.
 */

import {
  buildArtefacts,
  PIPELINE_VERSION,
  scanCorpus,
  writeArtefacts,
} from "./lib/artefacts.ts";
import { loadCatalog } from "./lib/catalog.ts";

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
const scan = await scanCorpus(corpusDir);
const t1 = performance.now();
const artefacts = buildArtefacts(catalog, warnings, scan);
const t2 = performance.now();
await writeArtefacts(artefactsDir, artefacts);
const t3 = performance.now();

const { stats } = artefacts.manifest;
console.log(
  `Built artefacts (pipeline ${PIPELINE_VERSION}) from ${corpusDir}\n` +
    `  compiled ${scan.files} files in ${Math.round(t1 - t0)}ms; ` +
    `built in ${Math.round(t2 - t1)}ms; ` +
    `written to ${artefactsDir} in ${Math.round(t3 - t2)}ms\n` +
    `  ${stats.authors} authors, ${stats.works} works, ` +
    `${stats.editions} editions, ${stats.units} blocks, ` +
    `${stats.tokens} tokens, ${stats.surfaces} surface forms, ` +
    `${stats.norms} normalised forms`,
);
if (warnings.length > 0) {
  console.warn(`${warnings.length} corpus warnings (recorded in manifest):`);
  for (const warning of warnings) console.warn(`  - ${warning}`);
}
