# Computer

The logic layer: loads a corpus of Markit texts from disk, builds derived
artefacts (compiled blocks, a tokenized text layer, a vocabulary, an inverted
index), and serves texts, search, and edition-diffing over a JSON HTTP API. No
presentation; no knowledge of any website.

## Running

```sh
deno task build   # build the derived artefacts into artefacts/ (gitignored)
deno task start   # serve on http://localhost:8420 (PORT to override)
deno task dev     # as above, restarting on source changes
```

Environment: `CORPUS_DIR` (default `../corpus`), `ARTEFACTS_DIR` (default
`./artefacts`), `PORT` (default 8420), `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST`
(per-client token bucket, default 20/100; 0 disables).

On boot the server checks the artefacts against the corpus (pipeline version +
file count + latest mtime) and rebuilds them itself if they are stale or
missing, so `deno task build` is an optimisation, not a requirement. Search is
answered entirely from the artefacts (~50MB heap, ms-fast); the catalog of
compiled documents is still also loaded into memory for the text/compare routes
(~600MB, ~10s — migrating those routes onto the artefacts is the planned next
step).

Clients are identified by the first `X-Forwarded-For` hop when present (set by a
reverse proxy or a trusted upstream site forwarding its visitors' IPs), else the
connection address.

## API

All routes are GET, return JSON (CORS-open, cached 5 minutes), and are typed in
[src/types.ts](src/types.ts) — the contract file that clients vendor.

| Route                                                       | Response                                  |
| ----------------------------------------------------------- | ----------------------------------------- |
| `/`                                                         | service health                            |
| `/catalog`                                                  | all authors, works, and editions          |
| `/authors/:author/works/:work/editions/:edition`            | title blocks + section tree               |
| `/authors/:author/works/:work/editions/:edition/full`       | the whole edition with text               |
| `/authors/:author/works/:work/editions/:edition/sections/*` | one section + prev/next/ancestors/compare |
| `/authors/:author/works/:work/compare/:a/:b`                | the two editions' aligned section lists   |
| `/authors/:author/works/:work/compare/:a/:b/sections/*`     | word-level diff of one section            |
| `/search?q=&mode=&author=&work=&edition=&page=&perPage=`    | ranked full-text hits, highlighted        |

Edition slugs are `main` (the work's reading text) or a year like `1757`,
`1742a`. Authors are ordered by year of first publication; works chronologically
within an author. Every work, edition, and section carries an `imported` flag
(sections inherit it from their ancestors): `false` means the text is a stub —
catalogued, but with no content to link to.

### Search

Bare terms are ANDed within a block; `"quoted phrases"` must appear in sequence;
`caus*` matches prefixes. `mode` selects the matching layer:

- `normalised` (default) — old and modern spellings find each other ("shew" ↔
  "show"), via accent/ligature/apostrophe folding plus the variant table in
  [src/lib/variants.json](src/lib/variants.json);
- `exact` — spellings match as written (case-insensitively), so "enquiry" and
  "inquiry" are distinct.

Each hit returns the **complete matched block, fully formatted**, with the
matched tokens wrapped in Markit `highlight` inline elements (`<mark>` in
renderHTML) — clients render it like any other block; no plain-text snippets.
Matches keep the spelling on the page: a normalised search for "show" highlights
_shew_.

## Artefacts

`deno task build` compiles the corpus and writes everything derived to
`ARTEFACTS_DIR` (~200MB for the current corpus, ~12s):

- `manifest.json` — pipeline version, corpus fingerprint, edition list, stats,
  build warnings.
- `vocab.json` — the type table: every distinct case-folded spelling (surface
  form) with document/collection frequencies and its normalised form, plus a
  lemma column (identity for now — reserved so lemmatisation only ever rewrites
  this small file).
- `units.json` — one row per block, columnar: location (edition/section/block),
  token count, and offsets into the per-edition files.
- `postings.bin` — the inverted index: per surface form, (unit, position) pairs
  as little-endian Uint32.
- `editions/<author>/<work>/<edition>/blocks.jsonl` + `text.txt` + `tokens.bin`
  — each compiled block as a JSON line (search hits are read back by byte
  range), the extracted plain text of every block, and the token stream as
  (surface id, char offset) pairs for future corpus analysis.

The design invariant: `text.txt` is exactly the output of `blockText` over the
compiled blocks, and every stored offset points into it. Extraction and
highlight-injection are the same traversal (`src/lib/text.ts`), which is what
lets match offsets recorded at build time be mapped back into a block's
formatted structure at serve time with no stored offset map. Anything that
changes extraction or tokenization must bump the version constant next to it;
the pipeline version is stamped into the manifest and mismatched artefacts are
rebuilt, while type-level changes (variants.json, future lemmas) only change
vocab.json.

The index is keyed by surface form and queries are expanded through the
vocabulary, so the normalised/exact layers (and a future lemma layer) share one
index. Document/collection frequencies and per-unit token counts are already
stored, so ranked retrieval (BM25/TF-IDF), frequency and distribution measures,
and document-term matrices for vectors/topic models can all be derived from
`vocab.json` + `units.json` + `tokens.bin` without touching the pipeline.

## Architecture

- `src/main.ts` — loads/refreshes artefacts and the catalog, starts
  `Deno.serve`.
- `src/build.ts` — CLI entry for the build pipeline.
- `src/server.ts` — routing shell: URL → api.ts call → JSON.
- `src/api.ts` — pure builders for every response type.
- `src/lib/catalog.ts` — scans the corpus (`authors/*.mit` +
  `works/<author>/<work>`), compiles Markit files, resolves `children` metadata
  references (inline section ids or relative file paths, recursively — this is
  how composite works like ETSS/FD/HE share text), cascades inherited metadata,
  and organises authors/works/editions/sections.
- `src/lib/text.ts` — canonical plain-text extraction from compiled blocks and
  highlight injection into them (one shared traversal).
- `src/lib/tokenize.ts` — the tokenizer (surface forms + offsets) and the
  type-level spelling normalisation.
- `src/lib/artefacts.ts` — builds, writes, loads, and freshness-checks the
  artefacts; byte-range block reads.
- `src/lib/search.ts` — query parsing, vocabulary expansion (exact/normalised),
  postings intersection with phrase positions, match-range mapping.
- `src/lib/diff.ts` — Myers word/punctuation diff; block alignment by Markit
  block ids.
- `src/lib/compare.ts` — section-tree alignment between editions.
- `src/ratelimit.ts` — per-client token bucket.

## Testing

```sh
deno task test    # core functions + API smoke tests, against tests/fixtures/corpus
deno task check   # typecheck + lint + format check
```

The tests never touch a real corpus: `tests/fixtures/corpus` is a miniature one
(two authors; a single-file work, a three-edition work with textual variants and
inline formatting, a composite work borrowing another work's text, and an
unimported stub). The fixture artefacts are built into a temp directory once per
test run, so the whole pipeline — build, write, load, byte-range reads — is
exercised by the suite.

## Known corpus issues (tolerated, served best-effort)

The corpus's own test pipeline (`deno task test` in corpus/) tracks the data
problems; the computer tolerates them rather than failing at startup. As of the
last sweep, 36 Hume files (empl1/empl2/he/fd) still have Markit compile errors
and are served best-effort. Any unresolvable `children` reference is logged as a
startup warning and its section is dropped (currently none).
