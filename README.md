# Computer

The logic layer: loads a corpus of Markit texts from disk, compiles and indexes
it in memory, and serves texts, search, and edition-diffing over a JSON HTTP
API. No presentation; no knowledge of any website.

## Running

```sh
deno task start   # serve on http://localhost:8420 (PORT to override)
deno task dev     # as above, restarting on source changes
```

Environment: `CORPUS_DIR` (default `../corpus`), `PORT` (default 8420),
`RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` (per-client token bucket, default 20/100;
0 disables). Startup compiles the whole corpus (~10s); nothing is cached on
disk.

Clients are identified by the first `X-Forwarded-For` hop when present (set by a
reverse proxy or a trusted upstream site forwarding its visitors' IPs), else the
connection address.

## API

All routes are GET, return JSON (CORS-open, cached 5 minutes), and are typed in
[src/types.ts](src/types.ts) — the contract file that clients vendor.

| Route                                                        | Response                                  |
| ------------------------------------------------------------ | ----------------------------------------- |
| `/`                                                          | service health                            |
| `/catalog`                                                   | all authors, works, and editions          |
| `/authors/:author/works/:work/editions/:edition`             | title blocks + section tree               |
| `/authors/:author/works/:work/editions/:edition/full`        | the whole edition with text               |
| `/authors/:author/works/:work/editions/:edition/sections/*`  | one section + prev/next/ancestors/compare |
| `/authors/:author/works/:work/compare/:a/:b`                 | the two editions' aligned section lists   |
| `/authors/:author/works/:work/compare/:a/:b/sections/*`      | word-level diff of one section            |
| `/search?q=&author=&work=&edition=&page=&perPage=`           | ranked full-text hits with snippets       |

Edition slugs are `main` (the work's reading text) or a year like `1757`,
`1742a`. Authors are ordered by year of first publication; works
chronologically within an author. Every work, edition, and section carries an
`imported` flag (sections inherit it from their ancestors): `false` means the
text is a stub — catalogued, but with no content to link to.

Search syntax: bare terms are ANDed within a paragraph; `"quoted phrases"`
must appear verbatim; `caus*` matches prefixes; old spellings are normalised
through [src/lib/variants.json](src/lib/variants.json) at index and query time.

## Architecture

- `src/main.ts` — loads everything, starts `Deno.serve`.
- `src/server.ts` — routing shell: URL → api.ts call → JSON.
- `src/api.ts` — pure builders for every response type.
- `src/lib/catalog.ts` — scans the corpus (`authors/*.mit` +
  `works/<author>/<work>`), compiles Markit files, resolves `children`
  metadata references (inline section ids or relative file paths, recursively
  — this is how composite works like ETSS/FD/HE share text), cascades
  inherited metadata, and organises authors/works/editions/sections.
- `src/lib/text.ts` — plain-text extraction from compiled blocks.
- `src/lib/diff.ts` — Myers word/punctuation diff; block alignment by Markit
  block ids.
- `src/lib/compare.ts` — section-tree alignment between editions.
- `src/lib/search.ts` — in-memory inverted index over every block of every
  edition; phrase/prefix/AND queries with positions.
- `src/ratelimit.ts` — per-client token bucket.

## Testing

```sh
deno task test    # core functions + API smoke tests, against tests/fixtures/corpus
deno task check   # typecheck + lint + format check
```

The tests never touch a real corpus: `tests/fixtures/corpus` is a miniature one
(two authors; a single-file work, a three-edition work with textual variants, a
composite work borrowing another work's text, and an unimported stub).

## Known corpus issues (tolerated, served best-effort)

The corpus's own test pipeline (`deno task test` in corpus/) tracks the data
problems; the computer tolerates them rather than failing at startup. As of the
last sweep, 36 Hume files (empl1/empl2/he/fd) still have Markit compile errors
and are served best-effort. Any unresolvable `children` reference is logged as a
startup warning and its section is dropped (currently none).
