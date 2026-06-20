/**
 * The config unit: environment -> settings, with the entry points' defaults.
 * Each test runs with env permission and restores the variables it touches.
 */

import { assertEquals } from "@std/assert";
import { artefactsDir, corpusDir, serverOptions } from "../src/config.ts";

/** Run `fn` with the given env vars set, restoring the previous values after. */
const withEnv = (
  vars: Record<string, string | undefined>,
  fn: () => void,
): void => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
};

const options = { permissions: { env: true } };

Deno.test(options, function corpusAndArtefactsDirs() {
  withEnv({ CORPUS_DIR: undefined, ARTEFACTS_DIR: undefined }, () => {
    // defaults are resolved relative to the module: ../corpus and ./artefacts
    assertEquals(corpusDir().endsWith("/corpus"), true);
    assertEquals(artefactsDir().endsWith("/artefacts"), true);
  });
  withEnv({ CORPUS_DIR: "/tmp/c", ARTEFACTS_DIR: "/tmp/a" }, () => {
    assertEquals(corpusDir(), "/tmp/c");
    assertEquals(artefactsDir(), "/tmp/a");
  });
  // an empty string is treated as unset (falls back to the default)
  withEnv({ CORPUS_DIR: "" }, () => {
    assertEquals(corpusDir().endsWith("/corpus"), true);
  });
});

Deno.test(options, function serverOptionsDefaultsAndOverrides() {
  withEnv({
    PORT: undefined,
    RATE_LIMIT_RPS: undefined,
    RATE_LIMIT_BURST: undefined,
  }, () => {
    assertEquals(serverOptions(), {
      port: 8420,
      rateLimit: { ratePerSecond: 20, burst: 100 },
    });
  });
  withEnv({ PORT: "9000", RATE_LIMIT_RPS: "5", RATE_LIMIT_BURST: "10" }, () => {
    assertEquals(serverOptions(), {
      port: 9000,
      rateLimit: { ratePerSecond: 5, burst: 10 },
    });
  });
});
