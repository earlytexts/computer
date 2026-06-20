/**
 * The two phase transitions that the entry points drive, factored out so they
 * share one implementation instead of each pasting the steps:
 *
 *   BUILD   corpus ──► artefacts/ on disk        (buildArtefactsToDisk)
 *   LOAD    artefacts/ ──► in-memory ServeArtefacts, rebuilding first if the
 *           on-disk artefacts are stale or missing (loadForServing)
 *
 * build.ts is the CLI for the build; main.ts and stdio.ts call loadForServing
 * to get ready-to-serve artefacts. The freshness-then-rebuild logic lives here
 * only, so "build" and "serve" are no longer tangled in the entry points.
 */

import {
  type Artefacts,
  artefactsFresh,
  type CorpusScan,
  scanCorpus,
  type ServeArtefacts,
} from "./artefacts.ts";
import { buildArtefacts, writeArtefacts } from "./build/builder.ts";
import { loadServeArtefacts } from "./serve/store.ts";
import { loadCatalog } from "./build/catalog.ts";

/**
 * Compile the corpus and write every derived artefact to `artefactsDir`,
 * returning the built artefacts (for the caller to report stats/warnings).
 * Pass `scan` to reuse a fingerprint already taken; otherwise it is computed.
 */
export const buildArtefactsToDisk = async (
  corpusDir: string,
  artefactsDir: string,
  scan?: CorpusScan,
): Promise<Artefacts> => {
  const { catalog, warnings } = await loadCatalog(corpusDir);
  const corpusScan = scan ?? await scanCorpus(corpusDir);
  const artefacts = buildArtefacts(catalog, warnings, corpusScan);
  await writeArtefacts(artefactsDir, artefacts);
  return artefacts;
};

/**
 * Load the artefacts the server runs from, rebuilding them from the corpus
 * first if they are stale or missing (so a `deno task build` is an
 * optimisation, not a requirement). `log` receives the freshness/rebuild line;
 * callers point it at stdout (HTTP) or stderr (stdio), or pass nothing to stay
 * quiet.
 */
export const loadForServing = async (
  corpusDir: string,
  artefactsDir: string,
  log: (message: string) => void = () => {},
): Promise<ServeArtefacts> => {
  const scan = await scanCorpus(corpusDir);
  if (await artefactsFresh(artefactsDir, scan)) {
    log(`Artefacts: ${artefactsDir} (fresh)`);
  } else {
    log(`Artefacts: ${artefactsDir} (stale or missing; rebuilding)`);
    await buildArtefactsToDisk(corpusDir, artefactsDir, scan);
  }
  return loadServeArtefacts(artefactsDir);
};
