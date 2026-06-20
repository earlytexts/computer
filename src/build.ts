/**
 * CLI entry point for the build pipeline: compile the corpus and write the
 * derived artefacts to disk (`deno task build`). The server does the same
 * on boot when its artefacts are stale, so running this is an optimisation
 * (fast deploys, CI checks), not a requirement.
 */

import { artefactsDir, corpusDir } from "./lib/config.ts";
import { PIPELINE_VERSION } from "./lib/artefacts.ts";
import { buildArtefactsToDisk } from "./lib/pipeline.ts";

const corpus = corpusDir();
const dir = artefactsDir();

const t0 = performance.now();
const { manifest } = await buildArtefactsToDisk(corpus, dir);
const elapsed = Math.round(performance.now() - t0);

const { stats, warnings } = manifest;
console.log(
  `Built artefacts (pipeline ${PIPELINE_VERSION}) from ${corpus} ` +
    `to ${dir} in ${elapsed}ms\n` +
    `  ${stats.authors} authors, ${stats.works} works, ` +
    `${stats.editions} editions, ${stats.units} blocks, ` +
    `${stats.tokens} tokens, ${stats.surfaces} surface forms, ` +
    `${stats.spellings} spellings, ${stats.forms} form buckets`,
);
if (warnings.length > 0) {
  console.warn(`${warnings.length} corpus warnings (recorded in manifest):`);
  for (const warning of warnings) console.warn(`  - ${warning}`);
}
