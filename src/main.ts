/**
 * HTTP entry point: load the artefacts (rebuilding them from the corpus first
 * if stale), then serve the REST + MCP routes. All building logic lives in
 * lib/pipeline.ts; this script only loads the in-memory state and starts the
 * server.
 */

import { artefactsDir, corpusDir, serverOptions } from "./lib/config.ts";
import { loadForServing } from "./lib/pipeline.ts";
import { createHandler } from "./lib/server.ts";
import { createRateLimiter } from "./lib/ratelimit.ts";

const corpus = corpusDir();

const t0 = performance.now();
const artefacts = await loadForServing(corpus, artefactsDir(), console.log);
const elapsed = Math.round(performance.now() - t0);

const { stats, warnings } = artefacts.manifest;
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
const limiter = createRateLimiter(rateLimit);
Deno.serve({ port }, createHandler({ artefacts, limiter }));
