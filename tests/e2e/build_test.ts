/**
 * End-to-end: the build CLI (src/build.ts) as a spawned process. The entry
 * point is a thin doer over the pipeline, so one run proves the wiring — env →
 * config, the Deno io adapter, and the artefacts landing on disk — is sound.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { materializeCorpus, testCorpus } from "../corpus.ts";

const root = new URL("../../", import.meta.url).pathname;
const denoFlags = ["run", "--allow-read", "--allow-write", "--allow-env"];

Deno.test("build.ts compiles the corpus and writes artefacts", async () => {
  const corpus = await materializeCorpus(testCorpus());
  const dir = await Deno.makeTempDir({ prefix: "computer-e2e-build-" });
  try {
    const { code, stdout } = await new Deno.Command(Deno.execPath(), {
      args: [...denoFlags, "src/build.ts"],
      cwd: root,
      env: { CORPUS_DIR: corpus, ARTEFACTS_DIR: dir },
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(code, 0);
    const out = new TextDecoder().decode(stdout);
    assertStringIncludes(out, "Built artefacts");
    assertStringIncludes(out, "2 authors");

    // the artefacts are really on disk: a manifest plus the fixed tables
    const manifest = JSON.parse(
      await Deno.readTextFile(`${dir}/manifest.json`),
    );
    assertEquals(manifest.stats.authors, 2);
    assertEquals(manifest.stats.works, 4);
    for (const name of ["catalog.json", "vocab.json", "units.json"]) {
      assert((await Deno.stat(`${dir}/${name}`)).isFile, `missing ${name}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(corpus, { recursive: true });
  }
});
