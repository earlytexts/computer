# The Early Text Computer — Architecture

For anyone changing the computer, human or otherwise. It covers how the code is
arranged and why, the invariants worth protecting, and where to put a new
feature. For what the routes do see the [API guide](./API.md); for the tool
surface, [the MCP guide](./MCP.md).

## Contents

- [The four layers](#the-four-layers)
- [The shape of the repository](#the-shape-of-the-repository)
- [Entry points](#entry-points)
- [The boundary](#the-boundary)
- [The core](#the-core)
- [The text engine](#the-text-engine)
- [Import discipline](#import-discipline)
- [The artefacts](#the-artefacts)
- [Testing](#testing)

## The four layers

Four layers stack upward: the **corpus** on disk → a swappable **reader** → the
**core** that answers every read/search/diff/frequency query over it → the
**HTTP and MCP servers** on top.

The keystone is the `Computer` interface ([src/types.ts](src/types.ts)): the
core's whole surface, with two interchangeable implementations — the in-process
one over the artefacts (`localComputer`) and the HTTP client that unwraps the
wire (`computerClient` in [src/client.ts](src/client.ts)). The servers are
written against `Computer` and do not care which they hold; the artefact cache
is an internal optimisation hidden entirely inside the core.

Two consequences worth stating, because they are what the interface buys:

- The MCP tools run in-process in production (no HTTP hop), but the same tool
  set runs over the network against a remote computer with no change.
- Every behavioural test drives the real `Computer` over an in-memory corpus, so
  the whole core beneath it can be rewritten without touching a test.

## The shape of the repository

```
src/
├── main.ts       # HTTP entry point
├── stdio.ts      # MCP-over-stdio entry point
├── build.ts      # artefact-build CLI
├── config.ts     # environment → settings
├── types.ts      # published: the wire contract and the Computer interface
├── client.ts     # published: the typed HTTP client
├── server.ts     # the HTTP shell: routing, serialization, the /mcp mount
├── ratelimit.ts  # per-client token bucket
├── mcp.ts        # the MCP server, over stdio and Streamable HTTP
├── tools.ts      # the corpus tools: definitions and handlers
├── render.ts     # responses → compact plain text
├── params.ts     # per-parameter validation, shared by both boundaries
├── requests.ts   # a raw key→value source → the typed *Params objects
├── scope.ts      # the one cross-parameter rule (editions vs edition)
└── core/         # everything below the Computer interface
```

Only `src/client.ts` and `src/types.ts` are published to JSR; the server and its
build artefacts are not.

Every module is ordered by the **stepdown rule**: the exports first, then the
helpers they call, then the helpers those call. A module reads top to bottom
from intent into detail.

## Entry points

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
  typed HTTP client other repos import from JSR (client.ts).

## The boundary

Above the core, depending only on the `Computer` interface. Two surfaces receive
requests — the REST API and the MCP tools — and the design principle throughout
is **two boundaries, one contract**: everything they could disagree about is
factored into a module they both import.

- **`server.ts`** — the HTTP shell: it parses each request into a `Computer`
  method call and serializes the result, plus routing, rate limiting, and the
  `/mcp` mount. It holds no corpus logic; slug resolution, the canonical-edition
  default, scoping and pagination all live in the `Computer` it is handed.
  `ratelimit.ts` is the token bucket.
- **`mcp.ts`** — the MCP server: `createMcpServer` (a connectable `Server`, for
  stdio) and `createMcpHandler` (the stateless Streamable HTTP handler mounted
  at `/mcp`), both over a `Computer`. The HTTP handler builds its tool set once
  and makes a fresh `Server` + transport per request, because the web-standard
  transport is single-use.
- **`tools.ts`** — the corpus tools: one definition (name, description, JSON
  Schema) and one handler per tool, rendering through `render.ts`. This is the
  single source of truth for the tools the MCP server serves and the Companion
  configures its model with.
- **`params.ts` / `requests.ts` / `scope.ts`** — the request contract, shared.
  `params.ts` owns the per-parameter rules (an enum value must be on its list, a
  count must be a whole number at or above its floor, a flag must be a
  recognised truth word, a route accepts no parameter it does not name);
  `scope.ts` owns the one cross-parameter rule (`editions` chooses a universe,
  `edition` pins one printing and needs a `work`); `requests.ts` states each
  method's parameter list exactly once and builds the typed `*Params` object
  from a `RawSource` — a key→value lookup that is `p.get(key)` over HTTP and
  `input[key]` over MCP. Where a value comes from is the only thing that differs
  between the two boundaries.
- **`render.ts`** — the one rendering core: API responses → compact plain text,
  serving both the REST API's `?format=text` and the MCP tools' results. Block
  content goes through Markit's `renderText`; everything here is presentation
  only. Search highlights become `«…»` and editorial markup `[-deleted-]` /
  `{+inserted+}`, since `renderText` would otherwise hide both.

A malformed parameter throws `ParamError`, which each boundary translates into
its own idiom — a `400` over HTTP, an error result over MCP — rather than
silently substituting a default. Over-maximum counts are the deliberate
exception: they are clamped by the response builders, which is a documented
behaviour rather than a mistake.

`params.ts` and `scope.ts` are dependency-free by design (they import only the
wire types, which erase), so either boundary can validate without pulling in the
core.

## The core

- **`mod.ts`** — the front door: `openComputer(io, paths)` loads the artefacts
  (rebuilding from the corpus first if stale), wires the lazy block, token, DTM,
  and topic stores, and returns a `Computer`. The artefact format never escapes
  this seam.
- **`io.ts`** — the swappable reader: the only module that touches the
  filesystem. It implements the `Io` adapter (corpus scan, artefact read/write,
  the lazy block reader) backed by Deno; everything below it is pure or reaches
  the disk through an injected port. Tests pass an in-memory `Io` over a dummy
  corpus.
- **`pipeline.ts`** — the two phase transitions over an `Io`:
  `buildArtefactsToDisk` (corpus → artefacts on disk) and `loadForServing`
  (ensure-fresh, rebuilding if stale, then load into memory).
- **`artefacts.ts`** — the artefact-format authority: the types, version
  constants, freshness check, and the `serializeArtefacts`/`parseArtefacts`
  codec the build and serve sides share. It does no I/O of its own and imports
  neither side.
- **`build/`** — corpus → in-memory artefacts. `catalogue.ts` (scan the corpus
  through an injected `CorpusFs`, compile Markit, resolve `children` references
  and cascade metadata — how composite works like ETSS/FD/HE share text) and
  `builder.ts` (fold the corpus into the tables).
- **`serve/`** — artefacts → API responses. `store.ts` (lazy block,
  token-stream, DTM, and topic-model reads — the block-store and token-store
  LRUs and byte-range reads and the cached document-term matrix and topic model,
  over an injected `BlockReader` — and catalogue lookups), `api.ts` (pure
  response builders), and `localComputer.ts` (the in-process `Computer`,
  resolving slugs and the canonical default over the api builders).

## The text engine

`core/text/` is the pure text and search engine, behind `mod.ts` (its public
API; the leaves are internal). `build/` and `serve/` import only `text/mod.ts`.

- `text.ts` — plain-text extraction and highlight injection, one shared
  traversal.
- `tokenize.ts` — the tokenizer plus the spelling/form/lemma type layers;
  `readings.ts` resolves an occurrence to its dictionary reading.
- `search.ts` — query parsing, vocabulary expansion, postings intersection with
  phrase positions.
- `keywords.ts` — keyness: log-likelihood and log-ratio over a target/reference
  partition.
- `collocations.ts` — positional co-occurrence around a node word, scored by
  G²/PMI/t-score.
- `similar.ts` — cosine similarity over the TF-IDF document vectors.
- `topics.ts` — aggregating the topic model's document-topic mix.
- `diff.ts` — Myers word/punctuation diff, block alignment by Markit ids.
- `compare.ts` — section-tree alignment between editions.
- `concordance.ts` — keyword-in-context lines.

The computer holds **no spelling or stemming heuristics of its own**. Word
identity (tokenization and folding) comes from `@earlytexts/corpus`, and
normalisation comes from the corpus's own register: a surface form's readings
are read at build time from `catalogue/dictionary.json` and the search-time
expansion runs over those. If a spelling should unite with another, that is an
edit to the corpus, not to this repository.

## Import discipline

Imports run strictly downward:

```
entry points → server.ts / mcp.ts → core/mod.ts → {build, serve} → text/mod.ts → artefacts.ts / types.ts
```

The filesystem is the one inversion: `io.ts` is the sole I/O module, and
`build/` and `serve/` reach the disk only through the `CorpusFs` and
`BlockReader` ports they define, which `io.ts` implements — so the rest of the
tree is pure and testable with in-memory fakes.

## The artefacts

`deno task build` compiles the corpus and writes everything derived to
`ARTEFACTS_DIR`. The on-disk format is defined in
[src/core/artefacts.ts](src/core/artefacts.ts):

- `manifest.json` — pipeline version, corpus fingerprint, edition list, stats,
  build warnings.
- `catalogue.json` — the Author → Work → Edition metadata tree, and per edition
  a section skeleton (the composed section tree, including borrowed children,
  with titles/breadcrumbs/imported flags) whose nodes carry the unit indices of
  their blocks rather than the blocks themselves. This serves the text and
  compare routes; block content is read from `blocks.jsonl` on demand.
- `vocab.json` — the type table: every distinct case-folded printed spelling
  (surface form) with document/collection frequencies, plus its dictionary
  **readings** (from the corpus register, or a lone identity reading when
  unregistered). A reading is a sequence of words (more than one for a
  contraction, `'tis` → "it is"), each a modern SPELLING and a citation LEMMA;
  the spelling/form search levels and every lemma-keyed statistic derive from
  these.
- `units.json` — one row per block, columnar: location (edition/section/block),
  token count, and offsets into the per-edition files.
- `postings.bin` — the inverted index over the edited reading text: per surface
  form, (unit, position) pairs as little-endian Uint32 (the position's high bit
  flags a capitalised occurrence, for case-sensitive search), followed by a
  per-posting reading column — the index (into the surface's readings, or the
  EXEMPT sentinel for a name/citation token) that occurrence resolved to in
  context, so search can narrow to the resolved reading and statistics count
  each occurrence under it.
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

### The design invariant

`text.txt` is exactly the output of `blockText` over the compiled blocks, and
every stored offset points into it. Extraction and highlight-injection are the
same traversal ([src/core/text/text.ts](src/core/text/text.ts)), which is what
lets match offsets recorded at build time be mapped back into a block's
formatted structure at serve time with no stored offset map.

**Anything that changes extraction or tokenization must bump the version
constant next to it.** The pipeline version is stamped into the manifest, and
mismatched artefacts are rebuilt. The corpus's dictionary is folded into the
corpus fingerprint too, so a register-only edit rebuilds the artefacts.

### Freshness at boot

On boot the server checks the artefacts against the corpus (pipeline version +
file count + latest mtime) and rebuilds them itself if they are stale or
missing, so running the artefact build ahead of boot is an optimisation, not a
requirement (the catalogue under `$CORPUS_DIR` must already exist, though). The
corpus is compiled into memory only to (re)build the artefacts; once they are
fresh the server runs entirely from them and boots in well under a second.

Every route is answered from the artefacts: search from the inverted index and
units (~50MB heap, ms-fast), the text/compare routes from `catalogue.json` plus
block content read lazily from each edition's `blocks.jsonl` under a small LRU,
and collocations from the per-edition `tokens.bin` read lazily under its own
LRU.

The index is keyed by surface form and queries are expanded through the
vocabulary, so the exact/spelling/form layers share one index. Search ranks hits
by BM25 (saturating term frequency, length-normalised by the per-unit token
counts; the `score` is opaque, only its ordering is contractual). Further
frequency and distribution measures can be derived from the same tables without
touching the pipeline.

## Testing

```sh
deno task test    # the suite, over an in-memory corpus
deno task check   # typecheck + lint + format check
```

The principle: **one fat behavioural seam, everything else thin wiring.** Every
read/search/diff/frequency behaviour is pinned once, through the `Computer`
interface, over a corpus authored in memory — so the entire core beneath it
(catalogue, build, codec, index, serve) is free to be refactored without
touching a test. The corpus is built in code, not on disk: `tests/corpus.ts`
provides a `corpus()` builder and `memoryCorpus` (a `CorpusFs` over a path →
`.mit` map), and `tests/helpers.ts`'s `openTestComputer` opens a `Computer` over
it through the real `openComputer` (artefacts kept in memory, no temp
directory).

- **`tests/core/`** — the behavioural seam, one file per `Computer` method
  (`catalogue`, `edition`, `section`, `compare`, `search`, `frequency`,
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
  (driven through the typed client plus the `/mcp` mount) / `stdio.ts` (driven
  by a real MCP client over stdin/stdout) — just enough to prove the wiring (env
  → config, the Deno io adapter, `Deno.serve`, the MCP transports) holds.

The shared corpus (`testCorpus()`) is a miniature one — two authors; a
single-file work, a three-edition work with textual variants and inline
formatting, a composite work borrowing another work's text, and an unimported
stub. Its variants and inflections are deliberate, so behaviours like match
levels and grouping stay observable in real output. Only the `io` and `e2e`
tests reach the disk.

The core keeps **100% coverage**: run `deno task test:coverage` after every
change, and if coverage drops, add tests or delete the unreachable code until it
is back. The full check before finishing is `deno task test`, `deno task check`
and `deno task fmt:check` — all three run in CI, along with
`deno publish --dry-run`.
