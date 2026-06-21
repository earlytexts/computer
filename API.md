# The Early Text Computer — API Guide

This is a guide to what the computer can do, written for the people who use it
to study the corpus rather than to run the server. It assumes no programming and
no statistics. Each route is a question you can ask the corpus; this page
explains the question, the answer you get back, and the knobs you can turn.

Wherever a result rests on a statistical measure, there is a short aside marked
like this:

> **📐 The maths behind it** _(skip freely — nothing below depends on reading
> it)._ A one-paragraph gesture at what the number means, for the curious.

You can ignore every one of those boxes and still use everything here.

## How to call it

Every route is a web address you fetch with an ordinary GET request; the answer
comes back as JSON. The same functions are also available as **MCP tools** (for
language-model clients) at `/mcp`. Responses are open to any website (CORS) and
cached for five minutes. A typical call looks like:

```
/search?q=natural+religion&author=hume
```

The part after `?` is a list of `name=value` options, joined by `&`. Every
option is optional unless stated otherwise; sensible defaults apply when you
leave one out. A value you _do_ supply must be valid, though: an option set to
something off its list (`match=fuzzy`), a count that is not a whole number or is
below 1 (`page=0`), or a name the route does not recognise (a typo like
`cassSensitive=1`) is answered with `400 Bad Request` and a message naming the
problem — rather than being quietly ignored in favour of the default. (A count
_above_ its documented maximum is the exception: it is clamped to the cap, not
refused.)

## Words this guide uses

A few terms recur across every route:

- **Author / work / edition.** The corpus is organised as authors → works →
  editions. You name each by its **slug**, a short lowercase label (e.g. author
  `hume`, edition `1742a`). The catalog route lists them all.
- **Edition slugs are years** — `1757`, `1742a` (the letter distinguishes two
  printings in one year). A work has one **canonical edition**: its default
  printing. If you don't name an edition, you get the canonical one.
- **Scope.** The search-family routes range over many works at once, so the
  edition scope is **two separate knobs**. `editions` chooses the _universe_:
  `canonical` (one printing per work — the default, and the usual choice) or
  `all` (every printing). Separately, `edition` (a year slug) pins to **one
  specific printing**, and is only meaningful together with a `work` — a bare
  year would name different, unrelated printings across different works, so it is
  refused without one. `author` and `work` narrow the scope further. (A year is
  only a stable name _within_ a work, which is why a specific edition needs one.)
- **Version.** Editorial work makes each edition _two_ texts: `edited`, the
  clean reading text (corrections applied), and `original`, the text as actually
  printed (corrections undone). The default is always `edited`. Reading routes
  also accept `both`, which returns the raw editorial markup (what was changed).
  `version` is offered wherever the text is read straight off the page — the
  reading routes and the phrase routes (search, frequency, concordance,
  keywords). It is _not_ offered on collocations, similar, or topics: those read
  a fixed index built once from the edited text, so there is no original to swap
  to. (Comparison routes accept `edited|original` but not `both`.)
- **Paging.** Two patterns, by the kind of answer. Routes that return passages —
  `/search` and `/concordance` — page through everything with `page` and
  `perPage` (default 20, up to 100). Routes that return a _ranked_ list cap it
  with `limit` instead (keywords, collocations, similar, topics/mix); there is
  no paging past the limit, because only the top of a ranking is meaningful.
  `/frequency` does neither — it returns every group, since the groups are few.
- **Imported flag.** Some works are catalogued but have no text yet (stubs).
  Every work, edition, and section carries an `imported` flag; `false` means
  "listed, but nothing to read".

## 1. Reading the texts

These routes hand back the texts themselves and their structure.

### The catalog — `/catalog`

The whole table of contents: every author, each of their works, and each work's
editions, with titles and publication years. Authors are ordered by when they
first published; works run chronologically within an author. Start here to find
the slugs you'll use everywhere else.

### A work — `/authors/:author/:work`

Opens a work to its canonical printing: the title-page material and a tree of
its sections (chapters, parts), but **not** the body text yet — just the
structure, so you can see what's inside and navigate it.

- Add `/full` — `/authors/:author/:work/full` — to get the whole text loaded in
  one response.
- `?version=edited|original|both` chooses which text (default `edited`).

### One section — `/authors/:author/:work/...`

A single section's text, addressed by its path down the tree appended straight
after the work (e.g. `/authors/:author/:work/book-1/chapter-2`). Alongside the
text you get **navigation**: the previous and next sections, the chain of
ancestors above it, and links to the same section in the work's other editions
(so you can jump straight across to compare). Add a trailing `/full` to pull in
the section's sub-sections too.

### A specific edition — `/authors/:author/:work/:edition/...`

Anything above can be pinned to a particular printing by inserting the edition's
year slug right after the work (e.g. `/authors/:author/:work/1742a/full`).
Without it, you're always reading the canonical edition. The slug is always
year-shaped (four digits, optional letter), which is how it's told apart from a
section name in the same position.

## 2. Comparing editions

These texts were revised across their lifetimes; these routes show what changed.

### Two editions side by side — `/authors/:author/:work/compare/:a/:b`

Lines up the section lists of two editions in reading order, so you can see
which chapters were added, dropped, or rearranged between printing _a_ and
printing _b_.

### A section, word by word — `.../compare/:a/:b/...`

A word-level diff of one section between the two editions. Words present only in
edition _a_ are marked as deletions, words only in _b_ as insertions — returned
as ordinary marked-up text, so it renders like any reading page (no special diff
view needed). `?version=edited|original` picks which text of each edition is
compared.

> **📐 The maths behind it** _(skip freely)._ The diff is a Myers
> shortest-edit-script alignment over words and punctuation, with whole blocks
> matched up first by their stable identifiers so only genuinely changed
> passages are diffed word-by-word.

## 3. Finding things

The search family locates words and phrases across the corpus. Three options
work the same way on all of them:

- **`q`** — your query. The **whole thing is treated as one phrase**: the words
  must appear together, in order. (There is no `AND`/`OR` or quoting yet.)
- **`match`** — how forgiving the matching is:
  - `exact` — the spelling exactly as written;
  - `spelling` — any spelling of the same word (so _encrease_ ↔ _increase_);
  - `form` — _(the default)_ also unites plurals and inflections, so "connection
    between cause" finds "connexion betwixt causes".
- **`caseSensitive`** — off by default (case ignored). Turn it on to require
  capitalisation to agree.

`version=edited|original` and the scope options (`author`, `work`, `editions`,
and `edition` for a single work) apply throughout, as described above. Matches
always keep the spelling on the page — a tolerant search for "show" still
highlights _shew_.

### Search — `/search`

Ranked full-text results. Each hit is the **complete matched block, fully
formatted**, with the matching words highlighted — you render it like any other
passage, not as a bare snippet. Paged with `page` and `perPage` (default 20, up
to 100 per page).

> **📐 The maths behind it** _(skip freely)._ Results are ordered by BM25, the
> standard relevance score: a passage ranks higher the more often the phrase
> occurs in it, with diminishing returns, and adjusted so that short passages
> aren't unfairly out-weighed by long ones. The `score` number itself is opaque
> — only the ordering is meaningful.

### Frequency — `/frequency`

How often your phrase occurs, **counted up and grouped** by `author`, `work`, or
`edition` (`groupBy=`). Each group reports the raw count and a **relative rate**
(per 1,000 words), so groups of different sizes can be compared fairly.

### Concordance — `/concordance`

One line per occurrence, shown **keyword-in-context**: your phrase with a few
words of context on each side — the classic concordance view for reading a word
across all its uses at once. `window` sets the words of context per side
(default 6, max 25 — the same knob `/collocations` calls `window`); `sort`
orders the lines by corpus `position` (default) or by the words nearest on the
`left` or `right`. Paged like search.

## 4. Statistical discovery

Where the search family answers "find me X", these routes answer "tell me what I
didn't know to ask" — they let the numbers surface patterns. They report a few
different measures side by side _on purpose_: each answers a slightly different
question, so you can rank by the one that fits yours.

### Distinctive words — `/keywords`

The one search route that takes **no query**. Name a target (an `author`,
optionally narrowed to a `work`) and it returns the words that target uses _more
than the rest of the corpus does_ — its characteristic vocabulary, its verbal
fingerprint. This is **keyness**. The comparison set is the rest of the edition
universe (canonical editions by default, or every printing with `editions=all`).

- `by` reports words as `lemma` (dictionary form — _causes/caused_ count as
  _cause_; the default), `form` (the inflection-tolerant bucket), or `exact`
  (spellings exactly as written). These name the same grain as `match`'s `form`
  and `exact`, so the two share one vocabulary.
- `min` is the noise floor (ignore words occurring fewer than this many times in
  the target; default 5); `limit` caps the rows (default 50).

No stop-word list is used — common function words simply score low, while a real
stylistic marker (_betwixt_ for _between_) rises to the top, which is the point.

> **📐 The maths behind it** _(skip freely)._ Each word carries two numbers, the
> standard pairing. **Log-likelihood** (Dunning's G²) measures _how sure_ we can
> be that the word's rate really differs between the target and the rest —
> strong evidence, not size of effect. **Log-ratio** measures the _size_ of the
> gap (how many times more often the target uses it). Read them together:
> confident _and_ large is what you want.

### Words that travel together — `/collocations`

Where keyness finds distinctive _words_, collocations find distinctive
_pairings_: given a node word `q`, the words that appear near it more often than
chance would predict — the conceptual neighbourhood of a term (what gathers
around _liberty_, _cause_, _passion_). It looks within a window of a few words
either side of each occurrence (`window`, default 5, max 25), never crossing a
paragraph boundary. Scope, `match`, and `by` work as elsewhere; `min` is the
co-occurrence floor (default 3) and `limit` caps the rows (default 50).

> **📐 The maths behind it** _(skip freely)._ Each collocate carries three
> measures that disagree by design, so you can rank by your question.
> **Log-likelihood** (G², the default) favours confident, often grammatical
> companions. **PMI** (pointwise mutual information) favours rarer,
> tightly-bound pairs — the vivid lexical neighbours. The **t-score** is a
> frequency-weighted confidence, the companion to PMI. High PMI = surprising
> partner; high t-score or G² = reliably attested partner.

### Texts that read alike — `/similar`

Given a target passage, the corpus items whose **vocabulary most resembles it**
— "what else in the corpus reads like this section on miracles?". Name the
target by `author`/`work` (and `edition`, and a section `path` for a single
section). `level` sets the grain of both the target and the results — `section`,
`edition`, or `work` (defaults to `section` if you give a path, else `edition`).
Results are drawn from the canonical editions, with the target's own work left
out, so the answer is always "what _else_ reads like this". `limit` caps the
rows (default 20, max 200).

> **📐 The maths behind it** _(skip freely)._ Each document is turned into a
> vector of **TF-IDF** weights — each word weighted up by how often it occurs in
> the document and down by how common it is across the whole corpus, so shared
> rare words count for more than shared common ones. Similarity is the
> **cosine** between two such vectors: 1 means identical vocabulary profiles, 0
> means none in common. The score is opaque; only its ordering matters.

### The corpus's themes — `/topics` and `/topics/mix`

A **topic model** is learned over the whole corpus: a set of recurring themes,
each one a cluster of words that tend to occur together, discovered
automatically rather than defined in advance.

- **`/topics`** is the model itself: each theme as its highest-weight words
  (what it's "about") and the works it's most prominent in (so you can trace a
  theme across authors and decades). `terms` and `works` cap those two lists
  (defaults 12 and 8).
- **`/topics/mix`** is the other face: point it at a target (the same
  `author`/`work`/`edition`/`path`/`level` options as `/similar`) and it returns
  the themes that target draws on most, each with its share — "what _this_ work
  is about". `limit` caps the themes returned (default 10).

> **📐 The maths behind it** _(skip freely)._ The model is a non-negative matrix
> factorisation (NMF) of the same document-word table that powers `/similar`: it
> factors the corpus into a handful of themes and, for each document, the mix of
> themes it's made of (the shares sum to 1). Very common words (the
> function-word glue, present in over half the documents) are set aside before
> training, so the themes carry meaning rather than grammar.

## Health and tooling

- **`/`** — a quick health check: confirms the service is up and reports how
  many authors and works it holds.
- **`/mcp`** — the same corpus functions exposed as MCP tools, for
  language-model clients (over Streamable HTTP).

The precise shapes of every response are typed in [src/types.ts](src/types.ts),
and a ready-made typed client lives in [src/client.ts](src/client.ts).
