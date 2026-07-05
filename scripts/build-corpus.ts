/**
 * Build the corpus's compiled `catalogue/` under Deno, in prod, where the corpus is
 * a Node-only package with no build entrypoint the Deno deploy can run. The
 * corpus's build functions are runtime-neutral (all I/O goes through an
 * injected `CorpusFs`), and `nodeCorpusFs` is `node:fs`-backed (which Deno
 * provides natively), so this wrapper simply drives them against the configured
 * corpus directory. Markit resolves via this project's import map (deno.json),
 * exactly as the computer already imports the corpus's `wire` types — so the
 * corpus checkout needs no `npm install` here.
 *
 * Run with: deno task build:corpus. In dev, run the corpus's own `npm run
 * build` instead; both produce byte-identical output.
 */

import { buildCatalogue } from "../../corpus/src/catalogue.ts";
import { writeCatalogue } from "../../corpus/src/catalogue-output.ts";
import { nodeCorpusFs } from "../../corpus/src/fs.ts";
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
