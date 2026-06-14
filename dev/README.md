# Development tools

Interactive CLIs for the maintainer, run from `computer/`. They are _not_ part
of the served service: they read the built artefacts (`artefacts/vocab.json` +
`manifest.json`) read-only and edit the curated override files under `src/lib/`.
Nothing here is imported by `src/`.

```
deno task dev:variants   # curate src/lib/variants.json (spelling normalisation)
deno task dev:lemmas     # curate src/lib/lemmas.json   (lemmatisation)
```

## What they do

Each tool walks every surface form in the corpus (commonest first) and, for
each, shows the decision-relevant view — not the internal Porter stem, which is
just a search-bucket key and reads confusingly (`his` → `hi`):

- **variants** — whether the surface is mapped to a modern spelling
  (`→ increase`) or searched as written, plus the other spellings sharing its
  search bucket (`groups with: …`). A bucket of only-archaic forms (e.g.
  `compleated` grouped with `compleating · compleats`) is the signal that a
  mapping is needed. An edit adds an override keyed on the surface's folded base
  form, valued at the modern spelling you type.
- **lemmas** — the citation lemma the surface is assigned (`→ be`), plus its
  inflectional `family` (the other surfaces sharing that lemma). An edit adds an
  override keyed on the surface itself.

The "groups with" / "family" lines reflect the corpus as last built; a mapping
you add this session shows immediately but only regroups on the next build.

At each surface you can **confirm** (Enter, no change needed), **edit** (type a
value, or `e <value>` in one go), **skip** (revisit later), or **quit** (`q`).
Edits are written to the JSON file immediately and take effect on the next
`deno task build`.

## Progress

Every step shows how many surfaces are accounted for (absolute + percent) and
how many remain. A surface counts as accounted once it has an override or has
been confirmed. Progress lives in `dev/state/` (gitignored), keyed by surface
string, so a session can be resumed later — and so it carries across a corpus
rebuild: stale surfaces are ignored, new ones appear as unaccounted, and the
tool flags when the corpus has been rebuilt since you last ran it. Skipped
surfaces stay in the remaining pool and come back round on the next run.
