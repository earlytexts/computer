---
name: query-corpus
description: >
  Query the Early Texts corpus (early-modern British philosophy/theology from
  the hand-press era) through the Computer's HTTP JSON API. Use whenever the
  user asks to look something up in the corpus: list or describe authors,
  find a work's or edition's slug, full-text search a phrase, read a section
  of a text, compare two editions of a work, or count how often a phrase
  occurs. Mirrors the tools the Companion CLI exposes.
---

# Querying the Early Texts corpus

The **Computer** is an HTTP JSON service (Deno, port **8420**) that catalogues,
serves, searches, and diffs the corpus. Everything below is a `GET` request you
make with `curl` via Bash and parse with `jq`. All text-processing logic lives
in the Computer — never reimplement search/diff/tokenisation here; just call the
API.

## Setup

- Base URL: `$COMPUTER_URL`, default `http://localhost:8420`.
- Always resolve the base once and check the service is up:

```bash
COMPUTER="${COMPUTER_URL:-http://localhost:8420}"
curl -sf "$COMPUTER/" >/dev/null || echo "computer not running (start it: deno task dev in computer/)"
```

- URL-encode every slug/path segment and query value (`curl --data-urlencode` for
  query strings, or `jq -rn --arg s "$x" '$s|@uri'` for path segments).
- A `404` means "not found" (bad slug/path) — re-check slugs. Other non-2xx
  means the Computer is unavailable.

## The corpus model

Organised **Author → Work → Edition**.

- **Author** has a `slug` (e.g. `hume`), name, dates, nationality, sex, year of
  first publication.
- **Work** has a `slug` within its author (e.g. `epm`), a title, and one or more
  **editions**. Each work has a **canonical edition** (`canonicalSlug`), used by
  default whenever you don't name an edition.
- **Edition** has a year `slug` (e.g. `1751`, `1742a`). An edition or section
  whose `imported` is `false` is a **stub**: its metadata is known but its text
  is not in the corpus — say so plainly rather than inventing text.
- Works are nested **sections** addressed by a slug **path** (array of slugs from
  the edition root down), e.g. `["1","2"]`. Get a work's table of contents before
  fetching sections.

## Grounding rules (carry these into answers)

- Base every claim on API results from the current conversation. **Do not answer
  from background knowledge.** If the corpus can't answer, or a text is a stub,
  say so.
- Quote **verbatim**: preserve original spelling, capitalisation, punctuation.
  Never modernise or "correct" a quotation.
- **Cite** author/work/edition for every claim, plus the section path for
  passages and the block id for quotations, e.g. `hume/epm/1751 § 1 [<blockId>]`.
- State plain bibliographical/textual facts; for contested interpretation,
  present the passages and let the user judge.

## Reading text out of responses

Block content is **structured Markit**, not a string. To pull rough plain text
from any response that contains `block`/`blocks`, collect the `plainText` nodes
in document order:

```bash
# rough plain text from a JSON blob's blocks (loses line breaks/spacing nuance)
jq -r '[.. | objects | select(.type=="plainText") | .content] | join(" ")'
```

Editorial/diff markup, when present, shows up as inline elements of type
`deletion` (text only in edition A), `insertion` (only in B), and `highlight`
(a search match). For exact quotation prefer the precise structure; the helper
above is for orientation.

---

## The seven core queries

### 1. List authors — resolve a name → slug, or survey who's in the corpus
```bash
curl -s "$COMPUTER/catalog" | jq '.authors[] | {slug, surname, forename, birth, death, nationality, works: (.works|length)}'
```
`/catalog` returns `{authors:[...], editionSlugs:[...]}`; authors are ordered by
year of first publication. Each author carries its full `works` (with editions),
so the catalog also answers query 2.

### 2. An author's works and editions — resolve a title → slug, see editions
```bash
curl -s "$COMPUTER/catalog" \
  | jq '.authors[] | select(.slug=="hume") | .works[]
        | {slug, title, published, canonicalSlug,
           editions: [.editions[] | {slug, published, imported}]}'
```
`"(canonical)"` = the edition matching `canonicalSlug`; `imported:false` = stub.

### 3. Full-text search
```bash
curl -s -G "$COMPUTER/search" --data-urlencode "q=cause and effect" | \
  jq '{total, page, pages, exactSpelling, caseSensitive,
       results: [.results[] | {author, work, edition, sectionPath, sectionTitle, blockId}]}'
```
Semantics:
- The **whole query is one phrase** — its words must appear consecutively, in
  order. No quoting needed. Use a **shorter** phrase if a long one returns
  nothing.
- **Tolerant by default**: ignores case and unites old/modern spellings,
  plurals, inflections (`connection between cause and effect` finds
  `connexion betwixt causes and effects`).
- `exactSpelling=1` — match the surface form as written (use for spelling
  questions / precise quotation).
- `caseSensitive=1` — require each word's initial capitalisation to agree.
- Scope: `author=`, `work=`, `edition=` (a year slug). By default only
  **canonical** editions are searched (one hit per work); pass `edition=all` to
  search every printing.
- `version=edited` (default) or `original` to search the original printed text.
- `page=` (1-based).
- Each result's `block` is the full matched block with matches wrapped in
  `highlight` inline elements — render/extract like any block.

### 4. Get an edition: metadata + front matter + table of contents
```bash
# canonical edition (omit /editions/<slug>):
curl -s "$COMPUTER/authors/hume/works/epm" | \
  jq '{edition: {slug: .edition.slug, published: .edition.published, copytext: .edition.copytext, imported: .edition.imported},
       sections: [.sections[] | {path, title, imported}]}'
# a specific edition:
curl -s "$COMPUTER/authors/hume/works/epm/editions/1751" | jq '.sections'
```
Call this **before** fetching sections, to find the right section paths. The
section tree is recursive (`children`).

### 5. Get one section's full text (+ subsections, nav, sibling editions)
```bash
# path segments after /sections/ , slash-joined and URL-encoded:
curl -s "$COMPUTER/authors/hume/works/epm/sections/1" \
  | jq '{title: .section.title, breadcrumb: .section.breadcrumb,
         imported: .section.imported,
         text: ([.section.blocks[]? | .. | objects | select(.type=="plainText") | .content] | join(" ")),
         children: [.section.children[]? | {path, title}],
         prev: .prev.path, next: .next.path,
         alsoIn: [.compareEditions[].slug]}'
# specific edition: .../editions/1751/sections/1   |  original text: ?version=original
```
Texts can be long — fetch only the sections you need. To get a section **and all
its descendants' text** in one call, append `/full`.

### 6. Compare two editions' section trees (what was added/dropped/moved)
```bash
curl -s "$COMPUTER/authors/hume/works/epm/compare/1751/1772" \
  | jq '.a.slug as $a | .b.slug as $b | [.rows[] | {title,
        where: (if .pathA and .pathB then "both" elif .pathA then "only \($a)" else "only \($b)" end),
        pathA, pathB, children}]'
```
Returns `rows` (recursive `AlignedRow`): a row with only `pathA` exists only in
edition A; only `pathB` exists only in B; both = present in both. Use this for
structural differences; use query 7 for word-level.

### 7. Compare one section word-by-word between two editions
```bash
curl -s "$COMPUTER/authors/hume/works/epm/compare/1751/1772/sections/1" \
  | jq '{title, aPath, bPath, prev: .prev.path, next: .next.path}'
# then extract the diff text, keeping markers, e.g.:
curl -s "$COMPUTER/authors/hume/works/epm/compare/1751/1772/sections/1" \
  | jq -r '.blocks[] | .. | objects
           | if .type=="deletion" then "[-" elif .type=="insertion" then "{+"
             elif .type=="plainText" then .content else empty end'
```
`blocks` is a Markit diff document: `deletion` = text only in edition A,
`insertion` = text only in edition B; unchanged words appear plainly. `version`
(`edited` default / `original`) applies to both sides.

---

## Bonus: phrase frequency (not in the Companion's toolset, but available)

```bash
curl -s -G "$COMPUTER/frequency" --data-urlencode "q=human nature" --data-urlencode "by=author" \
  | jq '{q, by, total, results: [.results[] | {label, count, tokens, relative}]}'
```
`by=author|work|edition` (default `work`). `count` = phrase occurrences,
`relative` = occurrences per 1000 tokens. Accepts the same `exactSpelling`,
`caseSensitive`, `version`, `author`, `work`, `edition` filters as search.

## Typical workflow

1. Resolve names → slugs with `/catalog` (queries 1–2).
2. For a passage: `/.../works/<work>` for the TOC (query 4), then a specific
   `/sections/<path>` (query 5).
3. For "where does X appear / who uses X": `/search` (query 3), widen with
   `edition=all` if needed, or `/frequency` to quantify.
4. For "what changed between editions": `/compare/<a>/<b>` (query 6), then
   `/compare/<a>/<b>/sections/<path>` for the wording (query 7).
5. Quote verbatim and cite author/work/edition § path [blockId].
