# The Early Text Computer

The Early Text Computer is a suite of functions for reading, searching, diffing,
and statistically analysing a corpus of Markit texts. It is designed for use
with the [Early Text Corpus](https://github.com/earlytexts/corpus), but in
principle would work with any corpus of Markit texts that follows the same
conventions.

The functions are exposed over a JSON HTTP API and the Model Context Protocol
(MCP), so they can be used by any client that speaks either protocol.

The code is written in TypeScript and runs on Deno.

## Running

```sh
deno task build   # build the derived artefacts into artefacts/ (gitignored)
deno task start   # start the HTTP server on port 8420 (PORT to override)
deno task dev     # as above, restarting on source changes
deno task stdio   # serve the corpus tools over MCP on stdio
```

Environment:

- `CORPUS_DIR` (default `../corpus`; assumes you have the corpus repo checked
  out alongside this one)
- `ARTEFACTS_DIR` (default `./artefacts`)
- `PORT` (default 8420)
- `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` (per-client token bucket, default
  20/100; 0 disables).

On boot the server checks the artefacts against the corpus (pipeline version +
file count + latest mtime) and rebuilds them itself if they are stale or
missing, so `deno task build` is an optimisation, not a requirement. The corpus
is compiled into memory only to (re)build the artefacts; once they are fresh the
server runs entirely from them and boots in well under a second. Every route is
answered from the artefacts: search from the inverted index and units (~50MB
heap, ms-fast), the text/compare routes from `catalog.json` (the metadata tree
and per-edition section skeletons) plus block content read lazily from each
edition's `blocks.jsonl` under a small LRU, and collocations from the
per-edition `tokens.bin` read lazily under its own small LRU.

Clients are identified by the first `X-Forwarded-For` hop when present (set by a
reverse proxy or a trusted upstream site forwarding its visitors' IPs), else the
connection address.

## Development Scripts

```sh
deno task dev:variants  # manage the variants.json spelling table
deno task dev:lemmas    # manage the lemmas.json citation table
```

The search and frequency/concordance layers are built on top of a spelling table
(`variants.json`) and a citation table (`lemmas.json`), which are maintained in
the `src/core/text/` directory. The `dev:variants` and `dev:lemmas` scripts run
a REPL that lets you inspect, add, and remove entries from these tables, and
write them back to disk. The tables are used at build time to expand queries and
compute canonical forms.

## API

REST routes are GET, return JSON (CORS-open, cached 5 minutes), and are typed in
[src/types.ts](src/types.ts) — the contract file clients vendor (alongside the
typed client in [src/client.ts](src/client.ts)). The corpus tools are also
served over MCP (Streamable HTTP) at `/mcp`.

| Route                                                                                                 | Response                                       |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `/`                                                                                                   | service health                                 |
| `/catalog`                                                                                            | all authors, works, and editions               |
| `/authors/:author/works/:work`                                                                        | canonical edition: title blocks + section tree |
| `/authors/:author/works/:work/full`                                                                   | the canonical edition with text                |
| `/authors/:author/works/:work/sections/*`                                                             | one section + prev/next/ancestors/compare      |
| `/authors/:author/works/:work/editions/:edition[/full\|/sections/*]`                                  | a specific edition                             |
| `/authors/:author/works/:work/compare/:a/:b`                                                          | the two editions' aligned section lists        |
| `/authors/:author/works/:work/compare/:a/:b/sections/*`                                               | word-level diff of one section                 |
| `/search?q=&match=&caseSensitive=&version=&author=&work=&edition=&page=&perPage=`                     | ranked full-text hits, highlighted             |
| `/frequency?q=&by=&match=&caseSensitive=&version=&author=&work=&edition=`                             | phrase counts grouped by author/work/edition   |
| `/concordance?q=&context=&sort=&match=&caseSensitive=&version=&author=&work=&edition=&page=&perPage=` | keyword-in-context lines                       |
| `/keywords?author=&work=&edition=&by=&version=&min=&limit=`                                           | a subcorpus's distinctive words (keyness)      |
| `/collocations?q=&by=&match=&window=&min=&limit=&author=&work=&edition=`                              | words occurring near a node word               |
| `/similar?author=&work=&edition=&path=&level=&limit=`                                                 | corpus items most lexically like a target      |
| `/topics?terms=&works=`                                                                               | the corpus topic model (themes + top terms)    |
| `/topics/mix?author=&work=&edition=&path=&level=&limit=`                                              | a target's topic mix (what a text is about)    |
| `/mcp` (POST/GET/DELETE)                                                                              | the corpus tools over MCP                      |

Edition slugs are year slugs like `1757` or `1742a`. A request without
`/editions/:edition` addresses the work's **canonical** edition (its default
printing); `edition=all` on search/frequency/concordance/keywords covers every
printing, and omitting `edition` scopes them to canonical editions only. Authors
are ordered by year of first publication; works chronologically within an
author. Every work, edition, and section carries an `imported` flag (sections
inherit it from their ancestors): `false` means the text is a stub — catalogued,
but with no content to link to.

### Search

The whole query is matched as **one phrase**: its words must appear
consecutively, in order, with no quoting (boolean and prefix queries are
deliberately left for later). Two independent options control matching:

- `match` — the type level each word is expanded over: `exact` (the spelling as
  written, case-folded), `spelling` (old and modern spellings of the same form,
  "encrease" ↔ "increase", via accent/ligature/apostrophe folding plus the
  variant table in [src/core/text/variants.json](src/core/text/variants.json)),
  or `form` (the tolerant default — also unites plurals and inflections, so
  "connection between cause" matches "connexion betwixt causes");
- `caseSensitive` — off by default (case ignored); on requires each word's
  initial capitalisation to agree.

`version` selects `edited` (default reading text) or `original` (the printed
text before editorial correction). Each hit returns the **complete matched
block, fully formatted**, with the matched tokens wrapped in Markit `highlight`
inline elements (`<mark>` in renderHTML) — clients render it like any other
block; no plain-text snippets. Matches keep the spelling on the page: a tolerant
search for "show" highlights _shew_.

`frequency` and `concordance` take the same
`q`/`match`/`caseSensitive`/`version` matching; frequency reports per-group
occurrence counts with a relative rate (per 1000 tokens), concordance one
keyword-in-context line per occurrence.

### Keywords

`keywords` is the one search-family route that takes **no query** — it is a
discovery tool. Name a target subcorpus (`author`, optionally narrowed to a
`work`) and it returns the words that subcorpus uses more than the rest of the
corpus does: its distinctive vocabulary, ranked by **keyness**. The reference is
the rest of the edition universe — canonical editions by default, the `edition`
scope otherwise (`all`, or a year slug) — so every unit is partitioned into
target, reference, or out of scope. With neither `author` nor `work` there is no
target and the result is empty.

Each term carries two complementary numbers, the standard corpus-linguistics
pairing: **log-likelihood** (Dunning's G²), the strength of evidence that the
term's rate differs between target and reference; and **log-ratio**, the effect
size (log₂ of the ratio of relative frequencies, with a zero reference count
smoothed by half an occurrence). Results are the over-represented terms
(positive log-ratio) ranked by G². No stop-word list is applied — function words
occur at similar rates in like prose and so score low, while a genuine stylistic
marker (_betwixt_ for _between_) is exactly what keyness is meant to surface.

`by` chooses the level terms are grouped and reported at: `lemma` (the default —
citation forms, so "causes"/"caused" count as "cause"), `form` (the
inflection-tolerant bucket), or `surface` (the spellings as written). `version`
counts over the `edited` reading text (default) or the `original`. `min` is the
noise floor on target occurrences (default 5); `limit` caps the rows (default
50). The route is answered entirely from `vocab.json` + `units.json` +
`postings.bin` — no block reads and no pipeline changes.

### Collocations

Where keyness finds distinctive _terms_, `collocations` finds distinctive
_pairings_: given a node word `q`, the words that occur near it more often than
chance — the conceptual neighbourhood of a term (what clusters around _liberty_,
_cause_, _passion_). Unlike keyness it is **positional**, so it is the one route
that reads the ordered token stream (`tokens.bin`): the node word's in-scope
units are walked and a window of ±`window` tokens (default 5, max 25) is taken
around each occurrence, clamped to the unit (a block) so context never crosses a
paragraph boundary. Overlapping windows count each context position once, so a
collocate's co-occurrence can never exceed its total frequency. Scope mirrors
the search family: the whole corpus (canonical editions) by default, narrowed by
`author`/`work`/`edition`; the node word is matched at the `match` level
(tolerant by default). Counting is over the edited reading text only — the token
stream exists for that version alone.

Each collocate carries three complementary association measures, which disagree
by design so a client can rank by the question it is asking: **log-likelihood**
(G², the default ranking — a 2×2 significance test that favours confident, often
grammatical collocates), **PMI** (the effect size — log₂ observed/expected,
favouring rarer, tightly-bound lexical neighbours), and a **t-score**
(frequency-weighted confidence, the companion to PMI). No stop-word list is
applied: t-score and G² surface the function-word collocates, PMI the lexical
ones. `by` groups collocates as `lemma` (default), `form`, or `surface`; `min`
is the co-occurrence noise floor (default 3); `limit` caps the rows (default
50). Marginal frequencies come from `postings.bin`, so only the node word's own
units are read from `tokens.bin` (cached per edition) — never the whole scope.

### Similar

Where keyness and collocations _characterise_ a text, `similar` finds its
_neighbours_: given a target, the corpus items whose vocabulary most resembles
it — "what else reads like this passage on miracles". It is the public face of
the document-term matrix (`dtm.bin`): each (edition, section) document is its
L2-normalised TF-IDF row, so the cosine similarity between two items is their
dot product. The `level` (`section`, `edition`, or `work`) sets the granularity
of both the target and the results — a single section, a whole edition, or a
whole work, the coarser two summing and re-normalising their constituent rows —
and defaults to `section` when a `path` is given, else `edition`. The target is
an `author`/`work`, narrowed by `edition` (canonical by default) and, at the
section level, a `path`; results are drawn from the canonical editions (one
printing per work) with the target's own work excluded. The score is an opaque
cosine in [0, 1], the same opacity as the search `score` — the vectors never
leave the server. `limit` caps the rows (default 20, max 200). The DTM is read
lazily on first use and cached (like `tokens.bin`), not loaded at boot.

### Topics

Where `similar` finds a text's neighbours, `topics` steps back to the corpus's
themes. A topic model is trained over the whole corpus at build time — a
non-negative matrix factorisation (NMF) of the document-term matrix into a
document-topic mix and a topic-term distribution — and the two routes read it
back. `/topics` is the model itself: each of the model's _K_ topics as its
highest-weight terms (what the topic is about) and the canonical-edition works
it is most prominent in (so a theme can be traced across authors and decades);
`terms` and `works` cap each list. `/topics/mix` is the other face: given a
target (an `author`/`work`, narrowed by `edition` and, at the section level, a
`path`, with the same `level` granularity and defaults as `similar`), it returns
the topics that target draws on most, each with its share (0–1) and a few top
terms — "what this work is about". The factors never leave the server; only
topic labels, terms, and shares do. The model is read lazily on first use and
cached, like the DTM.

Lemmas occurring in more than half the documents (the function-word glue) are
dropped from the model's view of the DTM before training, so topics carry
lexical signal rather than syntax; the stored DTM that `similar` reads keeps
every column.

## Artefacts

`deno task build` compiles the corpus and writes everything derived to
`ARTEFACTS_DIR`. The on-disk format is defined in
[src/core/artefacts.ts](src/core/artefacts.ts):

- `manifest.json` — pipeline version, corpus fingerprint, edition list, stats,
  build warnings.
- `catalog.json` — the Author → Work → Edition metadata tree, and per edition a
  section skeleton (the composed section tree, including borrowed children, with
  titles/breadcrumbs/imported flags) whose nodes carry the unit indices of their
  blocks rather than the blocks themselves. This serves the text and compare
  routes; block content is read from `blocks.jsonl` on demand.
- `vocab.json` — the type table: every distinct case-folded spelling (surface
  form) with document/collection frequencies, plus its canonical SPELLING and
  FORM bucket (the spelling- and inflection-tolerant search levels) and a
  citation-form LEMMA column for statistics.
- `units.json` — one row per block, columnar: location (edition/section/block),
  token count, and offsets into the per-edition files.
- `postings.bin` — the inverted index over the edited reading text: per surface
  form, (unit, position) pairs as little-endian Uint32 (the position's high bit
  flags a capitalised occurrence, for case-sensitive search).
- `postings-original.bin` + `overlay.json` — an overlay index over the original
  (pre-correction) text, covering only the units that carry editorial markup, so
  an `original` search reads those units from the overlay instead of the
  primary.
- `dtm.bin` + `dtm.json` — the document-term matrix: one sparse row per
  (edition, section) document of TF-IDF weights over lemma columns, stored CSR
  (row pointers, column ids, L2-normalised Float32 values) with the row/column
  labels and non-zero count in the JSON sidecar. The substrate for the vector
  routes — the `/similar` route and the topic model both read it; like
  `tokens.bin` it is read lazily by those routes, not loaded into memory at
  boot.
- `topics.bin` + `topics.json` — the topic model (NMF over the DTM): the
  document-topic mix as a dense Float32 matrix (one row per DTM document, each
  summing to 1), with the topic count, the document row labels, and each topic's
  top terms in the JSON sidecar. Trained at build time and read lazily by the
  `/topics` and `/topics/mix` routes.
- `editions/<author>/<work>/<edition>/blocks.jsonl` + `text.txt` + `tokens.bin`
  — each compiled block as a JSON line (search hits are read back by byte
  range), the extracted plain text of every block, and the token stream as
  (surface id, char offset) pairs. The collocations route reads `tokens.bin`
  lazily (the node word's units only, cached per edition); `text.txt` is for
  rebuilding the index and future corpus analysis.

The design invariant: `text.txt` is exactly the output of `blockText` over the
compiled blocks, and every stored offset points into it. Extraction and
highlight-injection are the same traversal
([src/core/text/text.ts](src/core/text/text.ts)), which is what lets match
offsets recorded at build time be mapped back into a block's formatted structure
at serve time with no stored offset map. Anything that changes extraction or
tokenization must bump the version constant next to it; the pipeline version is
stamped into the manifest and mismatched artefacts are rebuilt, while type-level
changes (variants.json, lemmas) only change vocab.json.

The index is keyed by surface form and queries are expanded through the
vocabulary, so the exact/spelling/form layers share one index. Search ranks hits
by BM25 (saturating term frequency, length-normalised by the per-unit token
counts; the `score` is opaque, only its ordering is contractual), and the
document-term matrix (`dtm.bin`) is built from the same `vocab.json` +
`units.json` + `postings.bin` as the TF-IDF substrate for the vector routes —
the `/similar` route and the topic model (`topics.bin`, an NMF factorisation of
the DTM serving `/topics` and `/topics/mix`) both consume it. Further frequency
and distribution measures can be derived the same way, without touching the
pipeline.

## Architecture

Four layers stack upward: the **corpus** on disk → a swappable **reader** → the
**core** that answers every read/search/diff/frequency query over it → the
**HTTP and MCP servers** on top. The keystone is the `Computer` interface
([src/types.ts](src/types.ts)): the core's whole surface, with two
interchangeable implementations — the in-process one over the artefacts
(`localComputer`) and the HTTP client that unwraps the wire (`computerClient` in
[src/client.ts](src/client.ts)). The servers are written against `Computer` and
do not care which they hold; the artefact cache is an internal optimisation
hidden entirely inside the core.

### Entry points (`src/`)

Thin doers that wire a unit or two together and run; they carry no business
logic of their own.

- [src/build.ts](src/build.ts) — CLI: compile the corpus and warm the artefact
  cache on disk.
- [src/main.ts](src/main.ts) — HTTP: `openComputer`, then serve the REST + MCP
  routes.
- [src/stdio.ts](src/stdio.ts) — the same corpus tools over MCP on stdio.
- [src/config.ts](src/config.ts) — environment → settings (corpus/artefacts
  dirs, port, rate limit); the core itself takes explicit paths.
- [src/types.ts](src/types.ts) + [src/client.ts](src/client.ts) — the public
  contract: the response types and the `Computer` interface (types.ts), and the
  typed HTTP client that other repos vendor (client.ts).

### The servers (`src/`)

Above the core, depending only on the `Computer` interface.

- `server.ts` — the HTTP shell: it parses each request into a `Computer` method
  call and serializes the result, plus routing, rate limiting, and the `/mcp`
  mount. `ratelimit.ts` is the token bucket.
- `mcp.ts` — the MCP server: `createMcpServer` (a connectable Server, for stdio)
  and `createMcpHandler` (the stateless HTTP handler), both over a `Computer`.
  `tools.ts` defines the corpus tools and `render.ts` renders responses to plain
  text for tool results.

### The core (`src/core/`)

- `mod.ts` — the front door: `openComputer(io, paths)` loads the artefacts
  (rebuilding from the corpus first if stale), wires the lazy block, token, DTM,
  and topic stores, and returns a `Computer`. The artefact format never escapes
  this seam.
- `io.ts` — the swappable reader: the only module that touches the filesystem.
  It implements the `Io` adapter (corpus scan, artefact read/write, the lazy
  block reader) backed by Deno; everything below it is pure or reaches the disk
  through an injected port. Tests pass an in-memory `Io` over a dummy corpus.
- `pipeline.ts` — the two phase transitions over an `Io`: `buildArtefactsToDisk`
  (corpus → artefacts on disk) and `loadForServing` (ensure-fresh, rebuilding if
  stale, then load into memory).
- `artefacts.ts` — the artefact-format authority: the types, version constants,
  freshness check, and the `serializeArtefacts`/`parseArtefacts` codec the build
  and serve sides share. It does no I/O of its own and imports neither side.
- `build/` — corpus → in-memory artefacts. `catalog.ts` (scan the corpus through
  an injected `CorpusFs`, compile Markit, resolve `children` references and
  cascade metadata — how composite works like ETSS/FD/HE share text) and
  `builder.ts` (fold the corpus into the tables).
- `serve/` — artefacts → API responses. `store.ts` (lazy block, token-stream,
  DTM, and topic-model reads — the block-store and token-store LRUs and
  byte-range reads and the cached document-term matrix and topic model, over an
  injected `BlockReader` — and catalog lookups), `api.ts` (pure response
  builders), and `localComputer.ts` (the in-process `Computer`, resolving slugs
  and the canonical default over the api builders).
- `text/` — the pure text/search engine, behind `mod.ts` (its public API; the
  leaves are internal). `text.ts` (plain-text extraction and highlight
  injection, one shared traversal), `tokenize.ts` (the tokenizer plus the
  spelling/form/lemma type layers), `search.ts` (query parsing, vocabulary
  expansion, postings intersection with phrase positions), `keywords.ts`
  (keyness: log-likelihood and log-ratio over a target/reference partition),
  `collocations.ts` (positional co-occurrence around a node word, scored by
  G²/PMI/t-score), `similar.ts` (cosine similarity over the TF-IDF document
  vectors), `topics.ts` (aggregating the topic model's document-topic mix),
  `diff.ts` (Myers word/punctuation diff, block alignment by Markit ids),
  `compare.ts` (section-tree alignment between editions), and `concordance.ts`
  (keyword-in-context lines). `build/` and `serve/` import only `text/mod.ts`.

Imports run strictly downward: entry points → `server.ts`/`mcp.ts` →
`core/mod.ts` → `{build, serve}` → `text/mod.ts` → `artefacts.ts`/`types.ts`.
The filesystem is the one inversion: `io.ts` is the sole I/O module, and
`build/` and `serve/` reach the disk only through the `CorpusFs` and
`BlockReader` ports they define, which `io.ts` implements — so the rest of the
tree is pure and testable with in-memory fakes.

## Testing

```sh
deno task test    # the suite, over an in-memory corpus
deno task check   # typecheck + lint + format check
```

The principle: **one fat behavioural seam, everything else thin wiring.** Every
read/search/diff/frequency behaviour is pinned once, through the `Computer`
interface, over a corpus authored in memory — so the entire core beneath it
(catalog, build, codec, index, serve) is free to be refactored without touching
a test. The corpus is built in code, not on disk: `tests/corpus.ts` provides a
`corpus()` builder and `memoryCorpus` (a `CorpusFs` over a path → `.mit` map),
and `tests/helpers.ts`'s `openTestComputer` opens a `Computer` over it through
the real `openComputer` (artefacts kept in memory, no temp directory).

- **`tests/core/`** — the behavioural seam, one file per `Computer` method
  (`catalog`, `edition`, `section`, `compare`, `search`, `frequency`,
  `concordance`), each driving the shared in-memory `Computer`. This is where
  match levels, scoping, pagination, grouping, version handling, highlighting,
  diffs, navigation and not-found are all pinned. `cache_test.ts` is the one
  test that knows the artefact cache exists — it pins the two properties the
  rest rely on being invisible: the codec round-trips, and a stale corpus is
  rebuilt while a fresh one is not.
- **`tests/wiring/`** — thin tests that the servers translate to and from the
  `Computer` correctly, not the corpus behaviour. `http_test.ts` (createHandler:
  routing, query parsing, status codes, headers, the rate limiter with an
  injected clock, the `/mcp` mount) and `mcp_test.ts` (createMcpServer through a
  real client: tool definitions, argument mapping, dispatch, error wrapping, and
  rendering).
- **`tests/io_test.ts`** — the real Deno disk adapter (serialize → write → read
  → parse, byte-range block reads, the freshness/replace guards) against a temp
  directory. **`tests/config_test.ts`** — environment → settings.
- **`tests/e2e/`** — one spawned-process test per entry point. Each materializes
  the in-memory corpus to a temp directory, then runs `build.ts` / `main.ts`
  (driven through the vendored client plus the `/mcp` mount) / `stdio.ts`
  (driven by a real MCP client over stdin/stdout) — just enough to prove the
  wiring (env → config, the Deno io adapter, `Deno.serve`, the MCP transports)
  holds.

The shared corpus (`testCorpus()`) is a miniature one — two authors; a
single-file work, a three-edition work with textual variants and inline
formatting, a composite work borrowing another work's text, and an unimported
stub. Its variants and inflections are deliberate, so behaviours like match
levels and grouping stay observable in real output. Only the `io` and `e2e`
tests reach the disk.
