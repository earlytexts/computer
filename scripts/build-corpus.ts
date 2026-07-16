/**
 * Build the corpus's compiled `catalogue/` by running the corpus checkout's own
 * `deno task build`. The checkout at `$CORPUS_DIR` is a full clone (see the
 * `install` task), so it carries its own build code and pinned dependencies —
 * the computer no longer imports the corpus compiler, it just drives the
 * checkout's task. The corpus build resolves its output root from its script's
 * own location, so it writes to `$CORPUS_DIR/catalogue`, exactly where the
 * computer reads it.
 *
 * Run as the first half of `deno task build`, before `src/build.ts` derives the
 * computer's own artefacts from the catalogue. In dev, this is identical to
 * running `deno task build` in the corpus checkout by hand.
 */

import { corpusDir } from "../src/config.ts";

const root = corpusDir();

const { code } = await new Deno.Command("deno", {
  args: ["task", "build"],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
}).output();

if (code !== 0) {
  console.error(`Corpus build failed in ${root} (exit ${code}).`);
  Deno.exit(code);
}
