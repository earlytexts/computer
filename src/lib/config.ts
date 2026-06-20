/**
 * Environment configuration for the entry points, in one place so the doers
 * (build.ts, main.ts, stdio.ts) carry no env-reading of their own.
 *
 * Defaults are resolved relative to this file: the corpus is a sibling of the
 * computer directory (`../corpus`), the artefacts live inside it
 * (`./artefacts`). Both can be overridden by environment variable.
 */

const env = (name: string): string | undefined => {
  const value = Deno.env.get(name);
  return value === undefined || value === "" ? undefined : value;
};

/** Absolute path resolved relative to this module (src/lib/). */
const fromHere = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);

/** The corpus directory: `$CORPUS_DIR`, else `../corpus` (sibling of computer). */
export const corpusDir = (): string =>
  env("CORPUS_DIR") ?? fromHere("../../../corpus");

/** The artefacts directory: `$ARTEFACTS_DIR`, else `./artefacts` in computer. */
export const artefactsDir = (): string =>
  env("ARTEFACTS_DIR") ?? fromHere("../../artefacts");

/** HTTP server options for main.ts, all from the environment with defaults. */
export const serverOptions = (): {
  port: number;
  rateLimit: { ratePerSecond: number; burst: number };
} => ({
  port: Number(env("PORT") ?? 8420),
  rateLimit: {
    ratePerSecond: Number(env("RATE_LIMIT_RPS") ?? 20),
    burst: Number(env("RATE_LIMIT_BURST") ?? 100),
  },
});
