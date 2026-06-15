/**
 * Curate src/lib/variants.json — the old-spelling → modern-spelling table the
 * SPELLING layer (`normalizeSpelling`) applies to canonicalise orthography.
 *
 * Walks every surface form in the corpus (commonest first), shows which
 * canonical spelling it currently maps to and the other spellings sharing that
 * bucket, and lets you add an override, confirm it, or skip it. An override is
 * keyed on the surface's *folded base* (the same form `normalizeSpelling` keys
 * the table on: apostrophes/accents/ligatures folded), and its value is the
 * modern spelling you type. A bucket of only-archaic spellings is the signal
 * that a mapping is missing.
 *
 *   deno task dev:variants
 */

import { foldBase } from "../src/lib/tokenize.ts";
import { loadArtefacts } from "./lib/artefacts.ts";
import { loadOverrides, lookup, saveOverrides } from "./lib/overrides.ts";
import { runCuration } from "./lib/curate.ts";
import { groupBy, groupLine } from "./lib/groups.ts";
import { cyan, dim } from "./lib/term.ts";

const variantsPath = decodeURIComponent(
  new URL("../src/lib/variants.json", import.meta.url).pathname,
);
const progressPath = decodeURIComponent(
  new URL("./state/variants-progress.json", import.meta.url).pathname,
);

const { vocab, manifest } = await loadArtefacts();
const variants = await loadOverrides(variantsPath);

const order = vocab.surfaces
  .map((_, i) => i)
  .sort((a, b) =>
    vocab.cf[b] - vocab.cf[a] ||
    (vocab.surfaces[a] < vocab.surfaces[b] ? -1 : 1)
  );

// Surfaces sharing a canonical spelling (the spelling-tolerant bucket), as last
// built.
const bucket = groupBy(
  vocab.surfaces.map((_, i) => vocab.spellings[vocab.surfaceSpelling[i]]),
  vocab.cf,
);

// The spelling decision: whether this surface is mapped to a modern spelling,
// and which other spellings share its canonical-spelling bucket. (The mapping
// is read live; the grouping is the last build's — a mapping you add now only
// regroups on the next `deno task build`.)
const statusLine = (i: number): string => {
  const mapped = lookup(variants, foldBase(vocab.surfaces[i]));
  const head = mapped
    ? `${cyan(`→ ${mapped}`)} ${dim("(variant in place)")}`
    : dim("· searched as written");
  const members = bucket.get(vocab.spellings[vocab.surfaceSpelling[i]]) ?? [];
  return `${head}   ${groupLine("groups with", members, i, vocab.surfaces)}`;
};

await runCuration({
  toolName: "variants",
  surfaces: vocab.surfaces,
  cf: vocab.cf,
  df: vocab.df,
  order,
  statusLine,
  editNoun: "modern spelling",
  applyEdit: async (i, value) => {
    variants[foldBase(vocab.surfaces[i])] = value;
    await saveOverrides(variantsPath, variants);
  },
  isModified: (i) =>
    lookup(variants, foldBase(vocab.surfaces[i])) !== undefined,
  overrideRelPath: "src/lib/variants.json",
  progressPath,
  builtAt: manifest.builtAt,
});
