/**
 * The two phase transitions that the entry points drive, factored out so they
 * share one implementation instead of each pasting the steps:
 *
 *   BUILD   corpus ──► artefacts/ on disk        (buildArtefactsToDisk)
 *   LOAD    artefacts/ ──► in-memory ServeArtefacts, rebuilding first if the
 *           on-disk artefacts are stale or missing (loadForServing)
 *
 * Both take an Io adapter: all filesystem effects go through it, and the steps
 * between (loadCatalog, buildArtefacts, the codec, isFresh) are pure. build.ts
 * is the CLI for the build; main.ts and stdio.ts call loadForServing. The
 * freshness-then-rebuild logic lives here only.
 */

import {
  type Artefacts,
  type CorpusScan,
  isFresh,
  parseArtefacts,
  serializeArtefacts,
  type ServeArtefacts,
} from "./artefacts.ts";
import { buildArtefacts } from "./build/builder.ts";
import { loadCatalog } from "./build/catalog.ts";
import type { Io } from "./io.ts";

/**
 * Compile the corpus and write every derived artefact to `artefactsDir`,
 * returning the built artefacts (for the caller to report stats/warnings).
 * Pass `scan` to reuse a fingerprint already taken; otherwise it is computed.
 */
export const buildArtefactsToDisk = async (
  io: Io,
  corpusDir: string,
  artefactsDir: string,
  scan?: CorpusScan,
): Promise<Artefacts> => {
  const { catalog, warnings } = await loadCatalog(io, corpusDir);
  const corpusScan = scan ?? await io.scanCorpus(corpusDir);
  const artefacts = buildArtefacts(catalog, warnings, corpusScan);
  await io.writeArtefacts(artefactsDir, serializeArtefacts(artefacts));
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
  io: Io,
  corpusDir: string,
  artefactsDir: string,
  log: (message: string) => void = () => {},
): Promise<ServeArtefacts> => {
  const scan = await io.scanCorpus(corpusDir);
  const manifest = await io.readManifest(artefactsDir);
  if (manifest !== null && isFresh(manifest, scan)) {
    log(`Artefacts: ${artefactsDir} (fresh)`);
  } else {
    log(`Artefacts: ${artefactsDir} (stale or missing; rebuilding)`);
    await buildArtefactsToDisk(io, corpusDir, artefactsDir, scan);
  }
  return parseArtefacts(await io.readArtefacts(artefactsDir));
};
