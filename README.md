# The Early Text Computer

The Early Text Computer is a suite of functions for reading, searching, diffing, and statistically analysing a corpus of Markit texts. It is designed for use with the [Early Text Corpus](https://github.com/earlytexts/corpus), but in principle would work with any corpus of Markit texts that follows the same conventions.

The functions are exposed over a JSON HTTP API and the Model Context Protocol (MCP), so they can be used by any client that speaks either protocol.

The code is written in TypeScript and runs on Deno.

## Running

```sh
deno task build   # build the derived artefacts into artefacts/ (gitignored)
deno task start   # start the HTTP server on port 8420 (PORT to override)
deno task dev     # as above, restarting on source changes
deno task stdio   # serve the corpus tools over MCP on stdio
```

Environment:

- `CORPUS_DIR` (default `../corpus`; assumes you have the corpus repo checked out alongside this one)
- `ARTEFACTS_DIR` (default `./artefacts`)
- `PORT` (default 8420)
- `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` (per-client token bucket, default 20/100; 0 disables).

On boot the server checks the artefacts against the corpus (pipeline version + file count + latest mtime) and rebuilds them itself if they are stale or missing, so `deno task build` is an optimisation, not a requirement. The corpus is compiled into memory only to (re)build the artefacts; once they are fresh the server runs entirely from them and boots in well under a second. Every route is answered from the artefacts: search from the inverted index and units (~50MB heap, ms-fast), and the text/compare routes from `catalog.json` (the metadata tree and per-edition section skeletons) plus block content read lazily from each edition's `blocks.jsonl` under a small LRU.

Clients are identified by the first `X-Forwarded-For` hop when present (set by a reverse proxy or a trusted upstream site forwarding its visitors' IPs), else the connection address.

## API

REST routes are GET, return JSON (CORS-open, cached 5 minutes), and are typed in [src/types.ts](src/types.ts) — the contract file clients vendor (alongside the typed client in [src/client.ts](src/client.ts)). The corpus tools are also served over MCP (Streamable HTTP) at `/mcp`.

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
| `/mcp` (POST/GET/DELETE)                                                                              | the corpus tools over MCP                      |

Edition slugs are year slugs like `1757` or `1742a`. A request without `/editions/:edition` addresses the work's **canonical** edition (its default printing); `edition=all` on search/frequency/concordance covers every printing, and omitting `edition` scopes them to canonical editions only. Authors are ordered by year of first publication; works chronologically within an author. Every work, edition, and section carries an `imported` flag (sections inherit it from their ancestors): `false` means the text is a stub — catalogued, but with no content to link to.

### Search

The whole query is matched as **one phrase**: its words must appear consecutively, in order, with no quoting (boolean and prefix queries are deliberately left for later). Two independent options control matching:

- `match` — the type level each word is expanded over: `exact` (the spelling as written, case-folded), `spelling` (old and modern spellings of the same form, "encrease" ↔ "increase", via accent/ligature/apostrophe folding plus the variant table in [src/lib/text/variants.json](src/lib/text/variants.json)), or `form` (the tolerant default — also unites plurals and inflections, so "connection between cause" matches "connexion betwixt causes");
- `caseSensitive` — off by default (case ignored); on requires each word's initial capitalisation to agree.

`version` selects `edited` (default reading text) or `original` (the printed text before editorial correction). Each hit returns the **complete matched block, fully formatted**, with the matched tokens wrapped in Markit `highlight` inline elements (`<mark>` in renderHTML) — clients render it like any other block; no plain-text snippets. Matches keep the spelling on the page: a tolerant search for "show" highlights _shew_.

`frequency` and `concordance` take the same `q`/`match`/`caseSensitive`/`version` matching; frequency reports per-group occurrence counts with a relative rate (per 1000 tokens), concordance one keyword-in-context line per occurrence.

## Artefacts

`deno task build` compiles the corpus and writes everything derived to `ARTEFACTS_DIR`. The on-disk format is
defined in [src/lib/artefacts.ts](src/lib/artefacts.ts):

- `manifest.json` — pipeline version, corpus fingerprint, edition list, stats, build warnings.
- `catalog.json` — the Author → Work → Edition metadata tree, and per edition a section skeleton (the composed section tree, including borrowed children, with titles/breadcrumbs/imported flags) whose nodes carry the unit indices of their blocks rather than the blocks themselves. This serves the text and compare routes; block content is read from `blocks.jsonl` on demand.
- `vocab.json` — the type table: every distinct case-folded spelling (surface form) with document/collection frequencies, plus its canonical SPELLING and
  FORM bucket (the spelling- and inflection-tolerant search levels) and a citation-form LEMMA column for statistics.
- `units.json` — one row per block, columnar: location (edition/section/block), token count, and offsets into the per-edition files.
- `postings.bin` — the inverted index over the edited reading text: per surface form, (unit, position) pairs as little-endian Uint32 (the position's high bit flags a capitalised occurrence, for case-sensitive search).
- `postings-original.bin` + `overlay.json` — an overlay index over the original (pre-correction) text, covering only the units that carry editorial markup, so an `original` search reads those units from the overlay instead of the primary.
- `editions/<author>/<work>/<edition>/blocks.jsonl` + `text.txt` + `tokens.bin` — each compiled block as a JSON line (search hits are read back by byte range), the extracted plain text of every block, and the token stream as (surface id, char offset) pairs for future corpus analysis.

The design invariant: `text.txt` is exactly the output of `blockText` over the compiled blocks, and every stored offset points into it. Extraction and highlight-injection are the same traversal ([src/lib/text/text.ts](src/lib/text/text.ts)), which is what lets match offsets recorded at build time be mapped back into a block's formatted structure at serve time with no stored offset map. Anything that changes extraction or tokenization must bump the version constant next to it; the pipeline version is stamped into the manifest and mismatched artefacts are rebuilt, while type-level changes (variants.json, lemmas) only change vocab.json.

The index is keyed by surface form and queries are expanded through the vocabulary, so the exact/spelling/form layers share one index. Document/ collection frequencies and per-unit token counts are already stored, so ranked retrieval (BM25/TF-IDF), frequency and distribution measures, and document-term matrices for vectors/topic models can all be derived from `vocab.json` + `units.json` + `tokens.bin` without touching the pipeline.

## Architecture

The shape is **thin entry points → a small set of units → free internals**.

### Entry points (`src/`)

Thin doers that wire a unit or two together and run; they carry no business logic of their own.

- [src/build.ts](src/build.ts) — CLI: compile the corpus and write the artefacts.
- [src/main.ts](src/main.ts) — HTTP: load the artefacts (rebuilding if stale), then serve the REST + MCP routes.
- [src/stdio.ts](src/stdio.ts) — the same corpus tools over MCP on stdio.
- [src/types.ts](src/types.ts) + [src/client.ts](src/client.ts) — the public contract: the response types and the typed HTTP client that other repos vendor.

### The units (`src/lib/`)

The seam between the entry points and the internals.

- `config.ts` — environment → settings (corpus/artefacts dirs, port, rate limit).
- `pipeline.ts` — the two phase transitions: `buildArtefactsToDisk` (corpus → artefacts on disk) and `loadForServing` (ensure-fresh, rebuilding if stale, then load into memory).
- `server.ts` — the HTTP handler: routing, JSON, rate limiting, and the `/mcp` mount; owns the per-handler block store (the blocks.jsonl LRU).
- `mcp.ts` — the MCP server: `createMcpServer` (a connectable Server, for stdio) and `createMcpHandler` (the stateless HTTP handler), both over the same tools.
- `artefacts.ts` — the on-disk artefact format: the types and version constants the build and serve sides share. It is the contract between them and imports neither.

### The internals (`src/lib/{build,serve,text}/`)

Below the units, grouped so the build/serve boundary is enforced by the import graph — `build/` and `serve/` both sit on `text/`, and neither imports the other.

- `build/` — corpus → artefacts on disk. `catalog.ts` (scan the corpus, compile Markit, resolve `children` references and cascade metadata — how composite works like ETSS/FD/HE share text) and `builder.ts` (fold the corpus into the tables and write them).
- `serve/` — artefacts → API responses. `store.ts` (load the artefacts, the block-store LRU, and catalog lookups), `api.ts` (pure response builders), `localComputer.ts` (an in-process implementation of the client's `Computer` interface, so the MCP tools run with no HTTP hop), `tools.ts` (the MCP tool definitions), `render.ts` (plain-text rendering of responses for tool results), and `ratelimit.ts` (the token bucket).
- `text/` — the pure text/search engine. `text.ts` (plain-text extraction and highlight injection, one shared traversal), `tokenize.ts` (the tokenizer plus the spelling/form/lemma type layers), `search.ts` (query parsing, vocabulary expansion, postings intersection with phrase positions), `diff.ts` (Myers word/punctuation diff, block alignment by Markit ids), `compare.ts` (section-tree alignment between editions), and `concordance.ts` (keyword-in-context lines).

Imports run strictly downward: entry points → units → `{build, serve}` → `text` → `artefacts.ts`/`types.ts`. (The one upward edge is `artefacts.ts` reading the two `*_VERSION` constants from `text/` to compose the pipeline version.)

## Testing

```sh
deno task test    # the suite, against tests/fixtures/corpus
deno task check   # typecheck + lint + format check
```

The intent (an aspiration the current suite is being migrated toward): **test at the units, leave the internals free**. The seam units are the contract — pinning their behaviour lets everything below them be refactored freely:

- the **build** unit, run against the fixture corpus, exercises catalog loading, compilation, tokenization, indexing, and writing through one call;
- the **HTTP** and **MCP** units exercise the serve-side internals (api, store, search, diff, compare, concordance, render) through requests and tool calls.

This is overridable where it earns its keep: the algorithmic leaves in `text/` (the tokenizer, the extraction/offset invariant in `text.ts`, the Myers diff) keep direct characterization tests, because routing every edge case through a seam is uneconomical and these are where subtle regressions hide; `ratelimit` keeps its own test too (it needs injected time). Migrating the remaining internal unit tests up to the seams is future work.

The tests never touch a real corpus: `tests/fixtures/corpus` is a miniature one (two authors; a single-file work, a three-edition work with textual variants and inline formatting, a composite work borrowing another work's text, and an unimported stub). The fixture artefacts are built into a temp directory once per test run, so the whole pipeline — build, write, load, byte-range reads — is exercised by the suite.
