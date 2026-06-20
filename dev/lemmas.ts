/**
 * Curate src/core/lemmas.json — the surface → citation-form overrides that
 * correct the lemma heuristic (`buildSurfaceLemma`) for forms it gets wrong.
 *
 * Walks every surface form in the corpus (commonest first), shows the lemma
 * the computer currently assigns it (heuristic, or an existing override) along
 * with its normalised form for context, and lets you add an override, confirm
 * it, or skip it. An override is keyed on the surface itself, exactly as the
 * file's existing entries are.
 *
 *   deno task dev:lemmas
 */

import { loadArtefacts } from "./lib/artefacts.ts";
import { loadOverrides, lookup, saveOverrides } from "./lib/overrides.ts";
import { runCuration } from "./lib/curate.ts";
import { groupBy, groupLine } from "./lib/groups.ts";
import { cyan } from "./lib/term.ts";

const lemmasPath = decodeURIComponent(
  new URL("../src/core/lemmas.json", import.meta.url).pathname,
);
const progressPath = decodeURIComponent(
  new URL("./state/lemmas-progress.json", import.meta.url).pathname,
);

const { vocab, manifest } = await loadArtefacts();
const lemmas = await loadOverrides(lemmasPath);

const order = vocab.surfaces
  .map((_, i) => i)
  .sort((a, b) =>
    vocab.cf[b] - vocab.cf[a] ||
    (vocab.surfaces[a] < vocab.surfaces[b] ? -1 : 1)
  );

// Live current lemma: this session's override, else the built heuristic value.
const lemma = (i: number): string =>
  lookup(lemmas, vocab.surfaces[i]) ?? vocab.surfaceLemma[i];

// Surfaces sharing a citation lemma (the inflectional family), as last built.
const family = groupBy(vocab.surfaceLemma, vocab.cf);

// The lemma decision (not the Porter stem): the citation form this surface is
// assigned, and the other forms that share it. Looking up by the live lemma
// shows the family this surface would join if you've just re-lemmatised it.
const statusLine = (i: number): string => {
  const lem = lemma(i);
  const members = family.get(lem) ?? [];
  return `${cyan(`→ ${lem}`)}   ${
    groupLine("family", members, i, vocab.surfaces)
  }`;
};

await runCuration({
  toolName: "lemmas",
  surfaces: vocab.surfaces,
  cf: vocab.cf,
  df: vocab.df,
  order,
  statusLine,
  editNoun: "lemma",
  applyEdit: async (i, value) => {
    lemmas[vocab.surfaces[i]] = value;
    await saveOverrides(lemmasPath, lemmas);
  },
  isModified: (i) => lookup(lemmas, vocab.surfaces[i]) !== undefined,
  overrideRelPath: "src/core/lemmas.json",
  progressPath,
  builtAt: manifest.builtAt,
});
