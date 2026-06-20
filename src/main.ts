/**
 * HTTP entry point: open the computer over the corpus (rebuilding the artefact
 * cache first if stale), then serve the REST + MCP routes. All the work lives
 * behind `openComputer`; this script only wires the Deno io adapter and config
 * to it and starts the server.
 */

import { artefactsDir, corpusDir, serverOptions } from "./config.ts";
import { denoIo, openComputer } from "./core/mod.ts";
import { createHandler } from "./server.ts";

const corpus = corpusDir();
const dir = artefactsDir();

const t0 = performance.now();
const { computer, manifest } = await openComputer(
  denoIo,
  { corpusDir: corpus, artefactsDir: dir },
  console.log,
);
const elapsed = Math.round(performance.now() - t0);

const { stats, warnings } = manifest;
console.log(
  `Corpus: ${corpus}\n` +
    `Ready in ${elapsed}ms: ` +
    `${stats.works} works by ${stats.authors} authors ` +
    `(${stats.units} blocks, ${stats.tokens} tokens, ` +
    `${stats.surfaces} surface forms).`,
);
if (warnings.length > 0) {
  console.warn(`${warnings.length} corpus warnings:`);
  for (const warning of warnings) console.warn(`  - ${warning}`);
}

const { port, rateLimit } = serverOptions();
Deno.serve({ port }, createHandler({ computer, rateLimit }));
