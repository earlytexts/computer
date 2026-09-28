# Pointing an agent at the corpus

The computer speaks the
[Model Context Protocol](https://modelcontextprotocol.io) as well as HTTP, so a
language model can read, search, compare and analyse the corpus directly — no
glue code, no scraping, no prompt full of pasted text.

This page is for whoever is wiring the agent up: the two transports, the tools
it will see, what they return, and the habits worth teaching it. For the same
functions as a JSON API, see the [API guide](./API.md); the two surfaces answer
the same questions and share one implementation, so nothing here contradicts
anything there.

## Contents

- [Two transports](#two-transports)
- [The tools](#the-tools)
- [What a tool returns](#what-a-tool-returns)
- [Shared arguments](#shared-arguments)
- [Worked examples](#worked-examples)
- [Errors](#errors)
- [Using the tools without MCP](#using-the-tools-without-mcp)

## Two transports

The same tools are served two ways. Which you want depends on whether the client
can reach a server or only spawn a process.

### Streamable HTTP — `/mcp`

The deployed service mounts MCP at `/mcp` on the same origin as the REST API, as
a stateless Streamable HTTP endpoint (POST, GET and DELETE; no session id, a
fresh server per request, replying with a single JSON response rather than an
SSE stream). This is the one to use for anything remote or shared, and needs
nothing installed.

```json
{
  "mcpServers": {
    "early-texts": {
      "type": "http",
      "url": "https://<the-computer-host>/mcp"
    }
  }
}
```

Locally, that URL is `http://localhost:8420/mcp` once `deno task start` is
running.

The endpoint sits behind the same per-client rate limiter as the REST routes
(default 20 requests/second, burst 100) and answers with
`access-control-allow-origin: *`.

### stdio

For clients that only spawn local processes (Claude Desktop, most editors), run
the server on stdin/stdout instead. It opens the corpus in-process, so there is
no HTTP hop at all.

```json
{
  "mcpServers": {
    "early-texts": {
      "command": "deno",
      "args": [
        "run",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "/path/to/computer/src/stdio.ts"
      ],
      "env": {
        "CORPUS_DIR": "/path/to/corpus"
      }
    }
  }
}
```

All startup messages go to stderr; stdout carries the protocol. The first run
builds the artefacts if they are missing or stale, which takes a while and logs
its progress to stderr; subsequent starts take well under a second. Run
`deno task build` once beforehand if your client is impatient about handshake
timeouts.

`--allow-write` is for the artefact cache, not the corpus: the computer never
writes to `CORPUS_DIR`. Nothing here reaches the network except the initial
module download, and every tool is read-only.

## The tools

Sixteen tools, in four groups. Descriptions and JSON Schemas live in
[src/tools.ts](src/tools.ts), which is the authority; this is the map.

**Finding your way around** — always the first calls, because everything else is
addressed by slug.

| Tool               | Answers                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `list_authors`     | Who is in the corpus (slug, name, dates, nationality, sex, first published) |
| `get_author_works` | One author's works and editions (slugs, titles, years, stub flags)          |

**Reading**

| Tool               | Answers                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `get_edition`      | An edition's metadata, front matter, and full table of contents                      |
| `get_section`      | One section's text, with subsections, previous/next, and matching sections elsewhere |
| `get_section_full` | A section and its whole subtree, in reading order                                    |
| `get_full_text`    | A whole edition in one response (long — prefer the two above)                        |
| `compare_editions` | Which sections two editions share, and which only one of them has                    |
| `compare_section`  | The word-level differences in one section between two editions                       |

**Searching** — the whole query is matched as one phrase.

| Tool          | Answers                                                             |
| ------------- | ------------------------------------------------------------------- |
| `search`      | Where a phrase occurs, as ranked, fully formatted blocks            |
| `frequency`   | How often it occurs, grouped by author, work or edition, with rates |
| `concordance` | Every occurrence keyword-in-context, one line each                  |

**Analysing** — the routes that answer questions you did not know to ask.

| Tool           | Answers                                                             |
| -------------- | ------------------------------------------------------------------- |
| `keywords`     | What vocabulary is distinctive of an author or work (keyness)       |
| `collocations` | What words cluster around a node word                               |
| `similar`      | What else in the corpus reads like a given text                     |
| `topics`       | The corpus's themes, as an unsupervised topic model                 |
| `topic_mix`    | Which of those themes a particular text draws on, and in what share |

Each tool's description is written for the model rather than for you: it says
what the tool is for, when to prefer it over its neighbour, and what the
defaults are. That is deliberate — a model that has read them picks
`concordance` over `search` for a usage question, and reaches for `get_edition`
before `get_full_text`, without being told to in the system prompt.

## What a tool returns

Every tool returns **plain text**, not JSON. The rendering is compact and
citeable: each result carries its author, work, edition, section path and block
id, so a model can quote a passage and say where it came from without a second
call.

Two conventions in the text, both for things a plain rendering would otherwise
lose:

- `«…»` marks a search highlight — the words that matched.
- `[-deleted-]` and `{+inserted+}` mark editorial or inter-edition differences —
  in a `compare_section` diff, and in any reading with `version="both"`.

This is the same rendering the REST API serves at `?format=text`, from the same
module ([src/render.ts](src/render.ts)), so `curl` output reads exactly as the
model sees it:

```sh
curl 'http://localhost:8420/search?q=constant+conjunction&author=hume&format=text'
```

That equivalence is the quickest way to debug a disappointing tool result: run
the matching route by hand and look at what the model was actually given.

## Shared arguments

A handful of arguments recur, and mean the same thing everywhere. The
[API guide](./API.md#words-this-guide-uses) explains them at length; in brief:

- **`author`, `work`, `edition`** — slugs. An edition slug is a year (`1751`,
  `1742a`). Omit `edition` and you get the work's canonical printing.
- **`path`** — a section path, as an array of slugs from the edition root
  (`["book-1", "part-3", "section-14"]`), exactly as `get_edition` lists them.
- **`match`** — `exact`, `spelling`, or `form` (the default, most tolerant:
  _connection between cause_ finds _connexion betwixt causes_). Tighten it for
  spelling questions and precise quotation.
- **`version`** — `edited` (the corrected reading text, the default) or
  `original` (the text as printed). The reading tools also take `both`, which
  shows the editorial markup itself.
- **`editions` vs `edition`** — on the searching and analysing tools these are
  two different knobs. `editions` chooses the universe: `canonical` (one
  printing per work, the default) or `all`. `edition` pins one specific
  printing, and is only valid together with a `work` — a bare year would name
  unrelated printings across different works, so it is refused on its own.

## Worked examples

The shape of a session, for a system prompt or a first conversation.

**"Does Hume use 'constant conjunction' more in the Treatise or the first
Enquiry?"** — `frequency` with `q="constant conjunction"`, `author="hume"`,
`groupBy="work"`. Read the per-1000-word rate, not the raw count: the Treatise
is several times longer.

**"How does Hume actually use the word 'sceptical'?"** — `concordance`, not
`search`. One line per occurrence with context either side is what shows a usage
pattern; whole blocks bury it.

**"What changed in the essay on miracles between editions?"** —
`get_author_works` for the edition slugs, then `compare_editions` to see which
sections moved, then `compare_section` on the one that matters.

**"What is distinctively Humean?"** — `keywords` with `author="hume"`. No query:
the statistics surface the words. Then `collocations` on whichever of them looks
interesting, to see the company it keeps.

**"What else in the corpus reads like this section?"** — `similar`, with the
target's `author`, `work` and `path`. Pair it with `topic_mix` on the same
target to say what it is about rather than only what it resembles.

Two habits worth teaching in a system prompt:

- **Resolve slugs first.** `list_authors` and `get_author_works` are cheap;
  guessing a slug is a wasted round-trip and an unnecessary "not found".
- **Read narrowly.** `get_edition` then `get_section` beats `get_full_text` for
  almost every question, and leaves room in the context for actual reasoning.

## Errors

Two different things happen, deliberately:

- **A bad argument** — an unknown argument name, a missing required one, an enum
  value off its list, a `page` below 1, an `edition` without a `work` — comes
  back as an MCP error result with a message naming the problem. Nothing is
  quietly defaulted, so a typo cannot silently answer a different question than
  the one asked. (A count _above_ its documented maximum is the exception: it is
  clamped to the cap.)
- **A slug that does not resolve** comes back as an ordinary text result:
  `Not found: author "humme". Check the slugs with list_authors,
  get_author_works, or get_edition.`
  This is a normal result rather than an error precisely so the model recovers
  by itself — which, in practice, it does.

## Using the tools without MCP

The tool set is a plain object, not an MCP construct: `createTools(computer)`
([src/tools.ts](src/tools.ts)) returns `{ definitions, run }`, where
`definitions` are name/description/JSON Schema triples in the shape every model
API wants for tool definitions, and `run(name, input)` returns the rendered
text.

```ts
import { computerClient } from "@earlytexts/computer";
import { createTools } from "./src/tools.ts";

const tools = createTools(computerClient("http://localhost:8420"));
// tools.definitions → pass straight to a model's tool parameter
// await tools.run("search", { q: "constant conjunction", author: "hume" })
```

It depends only on the `Computer` interface, so it runs over HTTP (a client) or
in-process (`localComputer`) unchanged. This is how the
[Companion](https://github.com/earlytexts/companion) drives its model, and it is
the reason the MCP tools and the CLI cannot drift apart: there is one definition
of each tool, and both surfaces mount it.

Note that `createTools` is not part of the published JSR package — only
`src/client.ts` and `src/types.ts` are. Reach for it from within this
repository, or from a checkout; from anywhere else, use MCP.
