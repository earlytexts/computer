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

The functions are exposed as GET routes returning JSON (CORS-open, cached 5
minutes) and as MCP tools (Streamable HTTP at `/mcp`). The wire contract is
typed in [src/types.ts](src/types.ts) — the file clients vendor, alongside the
typed client in [src/client.ts](src/client.ts).

For a guide to every route and what it does, written for researchers, see
**[API.md](API.md)**.

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
