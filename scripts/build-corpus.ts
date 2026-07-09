/**
 * Build the corpus's compiled `catalogue/` under Deno, in prod, from the pinned
 * corpus package rather than the checkout's own tooling. The corpus's build
 * functions are runtime-neutral (all I/O goes through an injected `CorpusFs`),
 * and `nodeCorpusFs` is `node:fs`-backed (which Deno provides natively), so
 * this wrapper simply drives them against the configured corpus directory.
 * They come from the corpus's published `build` subpath — the one build-time
 * seam that touches the compiler — resolved via this project's import map
 * (deno.json), exactly as its application code imports the corpus's `wire`
 * types. So the corpus checkout at $CORPUS_DIR is pure data: the code is the
 * pinned package version, and nothing needs installing there.
 *
 * Run as the first half of `deno task build`. In dev, running the corpus's own
 * `deno task build` produces byte-identical output.
 */

import {
  buildCatalogue,
  nodeCorpusFs,
  writeCatalogue,
} from "@earlytexts/corpus/build";
import { corpusDir } from "../src/config.ts";

const root = corpusDir();

const t0 = performance.now();
const { catalogue, warnings } = await buildCatalogue(nodeCorpusFs, root);
const { catalogue: written, documents } = await writeCatalogue(
  nodeCorpusFs,
  root,
  catalogue,
  warnings,
);

const elapsed = Math.round(performance.now() - t0);
const authors = written.authors.length;
const works = Object.keys(written.works).length;
const editions = documents.size;
console.log(
  `Built catalogue from ${root} to ${root}/catalogue in ${elapsed}ms\n` +
    `  ${authors} authors, ${works} works, ${editions} editions`,
);
if (warnings.length > 0) {
  console.warn(`${warnings.length} corpus warnings:`);
  for (const warning of warnings) console.warn(`  - ${warning}`);
}
