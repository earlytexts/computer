# The Early Text Computer

A suite of functions for reading, searching, comparing and statistically
analysing a corpus of [Markit](https://github.com/earlytexts/markit) texts —
served over a JSON HTTP API and the Model Context Protocol, so a web site, a
script, or a language model can all ask it the same questions.

It is built for the [Early Text Corpus](https://github.com/earlytexts/corpus),
but would work with any corpus of Markit texts following the same conventions.

```
/search?q=constant+conjunction&author=hume
/frequency?q=miracle&groupBy=work
/keywords?author=hume&work=thn
/concordance?q=sceptical&window=8
```

Search is tolerant by default: a query for _connection between cause_ finds
_connexion betwixt causes_, because normalisation comes from the corpus's own
register of spellings rather than from a stemming heuristic. Matches keep the
spelling on the page.

Everything is answered from artefacts built once from the corpus, so the service
boots in well under a second and answers in milliseconds.

## Where to go

| If you are…                 | Read                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| Asking the corpus questions | **[The API guide](./API.md)** — every route, written for researchers |
| Wiring up a language model  | [Pointing an agent at the corpus](./MCP.md)                          |
| Calling it from TypeScript  | [The client library](#the-client-library), below                     |
| Changing the code           | [Architecture](./ARCHITECTURE.md)                                    |

## Running

```sh
deno task install # clone the corpus into $CORPUS_DIR (deployment's data step)
deno task build   # build the gitignored artefacts (corpus catalogue, then artefacts/)
deno task start   # start the HTTP server on port 8420 in watch mode
deno task stdio   # serve the corpus tools over MCP on stdio
```

Environment:

- `CORPUS_DIR` (default `../corpus`; assumes you have the corpus repo checked
  out alongside this one)
- `ARTEFACTS_DIR` (default `./artefacts`)
- `PORT` (default 8420)
- `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` (per-client token bucket, default
  20/100; 0 disables)

Clients are identified by the first `X-Forwarded-For` hop when present (set by a
reverse proxy or a trusted upstream site forwarding its visitors' IPs), else the
connection address.

## The client library

The package publishes a small, dependency-free TypeScript client for the HTTP
API to [JSR](https://jsr.io/@earlytexts/computer):

```sh
deno add jsr:@earlytexts/computer      # Deno
npx jsr add @earlytexts/computer       # Node, Bun, and everything else
```

```ts
import { computerClient } from "@earlytexts/computer";
import type { CatalogueResponse } from "@earlytexts/computer/types";

const computer = computerClient("http://localhost:8420");
const catalogue: CatalogueResponse = await computer.catalogue();
const hits = await computer.search({
  q: "constant conjunction",
  author: "hume",
});
```

The client implements the `Computer` interface — the same one the servers are
written against — so a caller can hold either it or the in-process core without
noticing. Reads return `undefined` for a 404 (the caller renders its own
not-found page) and throw for anything else; `isComputerUnavailable` tells "the
computer could not serve us" apart from a bug on our side.

Only `src/client.ts` (the client) and `src/types.ts` (the wire contract) are
published; the server and its build artefacts are not. See
[src/types.ts](src/types.ts) for the full method surface and every response
shape.

## The API

The functions are exposed as GET routes returning JSON (CORS-open, cached five
minutes), and as MCP tools over Streamable HTTP at `/mcp`. Any route also takes
`?format=text` for the compact plain-text rendering the MCP tools return — one
rendering core, so the two surfaces cannot drift.

- **[The API guide](./API.md)** — every route and what it does, written for the
  people who use the computer to study the corpus rather than to run it.
- **[The MCP guide](./MCP.md)** — the tool surface: both transports, the sixteen
  tools, and how to point an agent at the corpus.

## Artefacts

`deno task build` compiles the corpus and writes everything derived — the
catalogue and section skeletons, the vocabulary, the inverted index, the
document-term matrix, the topic model, and each edition's blocks and token
stream — to `ARTEFACTS_DIR`. Every route is answered from these, not from the
corpus.

The build is an optimisation, not a prerequisite: on boot the server checks the
artefacts against the corpus (pipeline version + file count + latest mtime) and
rebuilds them itself if they are stale or missing. The corpus catalogue under
`$CORPUS_DIR` must already exist, though — that is what `deno task install` and
the corpus's own `deno task build` produce.

The on-disk format, the freshness rules, and the offset invariant that ties them
to the corpus are documented in
[the architecture notes](./ARCHITECTURE.md#the-artefacts).

## Development

```sh
deno task test    # the suite, over an in-memory corpus (test:coverage for a report)
deno task check   # typecheck + lint
deno task fmt     # format in place (fmt:check to verify)
```

The core keeps 100% test coverage. Read
[the architecture notes](./ARCHITECTURE.md) before making a change.

## Licence

MIT — see [the licence](./LICENSE.md).
