/**
 * The core's front door. `openComputer` is the single way to turn a corpus into
 * an answerable `Computer`: it loads the artefacts (rebuilding them from the
 * corpus first if they are stale or missing), wires up the lazy block store, and
 * binds the in-process `Computer` implementation over them. The artefact format
 * — the on-disk cache the build produces — is an internal optimisation behind
 * this seam; nothing above the core sees `ServeArtefacts`, the codec, or the
 * block store.
 *
 * Everything the core needs from the outside world arrives through the injected
 * `Io` (the swappable reader): production passes `denoIo`; tests pass an
 * in-memory equivalent over a dummy corpus. `buildArtefactsToDisk` is re-exported
 * for build.ts, which warms the cache as a deploy/CI optimisation.
 */

import { type Manifest, PIPELINE_VERSION } from "./artefacts.ts";
import { buildArtefactsToDisk, loadForServing } from "./pipeline.ts";
import {
  createBlockStore,
  createDtmStore,
  createTokenStore,
  createTopicsStore,
} from "./serve/store.ts";
import { localComputer } from "./serve/localComputer.ts";
import { denoIo, type Io } from "./io.ts";
import type { Computer } from "../types.ts";

export { buildArtefactsToDisk, denoIo, PIPELINE_VERSION };
export type { Computer, Io, Manifest };

/**
 * Open a `Computer` over the corpus. Loads the artefacts (building them first if
 * stale or missing, so a prior `deno task build` is an optimisation, not a
 * requirement), then returns the in-process `Computer` and the build manifest
 * (for the caller to report stats/warnings). `log` receives the freshness/
 * rebuild line; callers point it at stdout (HTTP) or stderr (stdio), or omit it.
 */
export const openComputer = async (
  io: Io,
  paths: { corpusDir: string; artefactsDir: string },
  log: (message: string) => void = () => {},
): Promise<{ computer: Computer; manifest: Manifest }> => {
  const artefacts = await loadForServing(
    io,
    paths.corpusDir,
    paths.artefactsDir,
    log,
  );
  const reader = io.blockReader(paths.artefactsDir);
  const store = createBlockStore(artefacts, reader);
  const tokens = createTokenStore(artefacts, reader);
  const dtm = createDtmStore(reader);
  const topics = createTopicsStore(reader);
  return {
    computer: localComputer(artefacts, store, tokens, dtm, topics),
    manifest: artefacts.manifest,
  };
};
