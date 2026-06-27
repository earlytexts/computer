/**
 * In-memory corpora for the tests. The computer reads the corpus through a
 * `CorpusFs` port (src/core/build/catalog.ts), so a corpus is just a map of
 * paths to `.mit` text — no fixture files on disk. `corpus()` is a small builder
 * for authoring one ergonomically; `memoryCorpus` turns a file map into the
 * `CorpusFs` the catalog scan walks; `materializeCorpus` writes a map to a real
 * directory for the few tests that spawn a process (e2e).
 *
 * `testCorpus()` is the shared corpus the behavioural suite runs against — two
 * authors with a single-file work, a three-edition work with textual variants
 * and inline formatting, a composite work borrowing another's text, and an
 * unimported stub. Its variants and inflections are deliberate, so match levels,
 * grouping, diffing and version handling stay observable in real output.
 */

import type { CorpusFs } from "../src/core/build/catalog.ts";

/** The root every corpus path hangs off (an arbitrary absolute prefix). */
export const CORPUS_ROOT = "/corpus";

/**
 * Collapse a path's empty and "." segments. Every path reaching this in-memory
 * FS descends from the absolute corpus root, so the result is always absolute.
 */
const normalizePath = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    out.push(part);
  }
  return "/" + out.join("/");
};

/* ------------------------------ corpus FS ----------------------------- */

/** A `CorpusFs` over a (possibly mutable) map of normalised path → file text. */
export const memoryCorpus = (files: Record<string, string>): CorpusFs => ({
  readFile: (path) => Promise.resolve(files[normalizePath(path)] ?? null),
  readDir: (path) => {
    const normalized = normalizePath(path);
    const prefix = normalized === "/" ? "/" : normalized + "/";
    const children = new Map<string, boolean>(); // name → isFile
    for (const key of Object.keys(files)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) children.set(rest, true);
      else children.set(rest.slice(0, slash), false);
    }
    if (children.size === 0) throw new Error(`no such directory: ${path}`);
    return Promise.resolve(
      [...children].map(([name, isFile]) => ({
        name,
        isFile,
        isDirectory: !isFile,
        isSymlink: false,
      })),
    );
  },
  realPath: (path) => Promise.resolve(normalizePath(path)),
  stat: (path) => {
    const key = normalizePath(path);
    if (files[key] !== undefined) return Promise.resolve({ isFile: true });
    const prefix = key + "/";
    return Promise.resolve(
      Object.keys(files).some((k) => k.startsWith(prefix))
        ? { isFile: false }
        : null,
    );
  },
});

/** Count the `.mit` files in a corpus map (the corpus scan's file count). */
export const countMit = (files: Record<string, string>): number =>
  Object.keys(files).filter((k) => k.endsWith(".mit")).length;

/** Write a corpus map to a fresh temp directory; returns the dir to clean up. */
export const materializeCorpus = async (
  files: Record<string, string>,
): Promise<string> => {
  const dir = await Deno.makeTempDir({ prefix: "computer-corpus-" });
  for (const [key, content] of Object.entries(files)) {
    const rel = key.slice(CORPUS_ROOT.length + 1); // strip "/corpus/"
    const path = `${dir}/${rel}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  return dir;
};

/* ------------------------------- builder ------------------------------ */

type Scalar = string | number | boolean;
/** A `.mit` `[metadata]` block, as a record (arrays become inline TOML arrays). */
export type Meta = Record<string, Scalar | Scalar[]>;

const tomlValue = (value: Scalar | Scalar[]): string =>
  Array.isArray(value)
    ? `[${value.map(tomlValue).join(", ")}]`
    : typeof value === "string"
    ? JSON.stringify(value)
    : String(value);

const toml = (meta: Meta): string =>
  Object.entries(meta).map(([k, v]) => `${k} = ${tomlValue(v)}`).join("\n");

const doc = (heading: string, meta: Meta, body = ""): string =>
  `${heading}\n\n[metadata]\n${toml(meta)}\n${body ? `\n${body}\n` : ""}`;

/** A fluent builder for a corpus map: author/work/edition files under the root. */
export class CorpusBuilder {
  private files: Record<string, string> = {};

  /** `data/authors/<slug>.mit`: the author's metadata (no text). */
  author(slug: string, meta: Meta): this {
    this.files[`${CORPUS_ROOT}/data/authors/${slug}.mit`] = doc(
      `# ${slug}`,
      meta,
    );
    return this;
  }

  /** `data/works/<author>/<work>/index.mit`: the work's edition-independent identity. */
  work(author: string, work: string, meta: Meta): this {
    this.files[`${CORPUS_ROOT}/data/works/${author}/${work}/index.mit`] = doc(
      `# ${author}.${work}`,
      meta,
    );
    return this;
  }

  /** `data/works/<author>/<work>/<slug>.mit`: a year-named edition with its text. */
  edition(
    author: string,
    work: string,
    slug: string,
    meta: Meta,
    body = "",
  ): this {
    this.files[`${CORPUS_ROOT}/data/works/${author}/${work}/${slug}.mit`] = doc(
      `# ${author}.${work}.${slug}`,
      meta,
      body,
    );
    return this;
  }

  /** Escape hatch: write a raw file at a root-relative path. */
  file(relPath: string, content: string): this {
    this.files[`${CORPUS_ROOT}/${relPath}`] = content;
    return this;
  }

  /** The corpus map (a fresh copy). */
  build(): Record<string, string> {
    return { ...this.files };
  }
}

export const corpus = (): CorpusBuilder => new CorpusBuilder();

/* --------------------------- the shared corpus ------------------------ */

const SOLO_1740 = `{#title}
^1 A SOLITARY TREATISE.

## 1

[metadata]
title = "Part 1"
breadcrumb = "Part 1"

{#title}
^1 PART I.

### 1

[metadata]
title = "Part 1, Section 1"
breadcrumb = "Section 1"

{#1}
Of the understanding, and of the passions; a deep and abstruse philosophy.

{#2}
The editor [-corrcted-][+corrected+] the text and [+also+] revised it.

### 2

[metadata]
title = "Part 1, Section 2"
breadcrumb = "Section 2"

{#1}
The mind never perceives any real connexion among distinct existences.

{#2}
From experience alone we infer the connexion betwixt causes and effects.

## 2

[metadata]
imported = false
title = "Part 2"
breadcrumb = "Part 2"`;

const TW_1750 = `{#title}
^1 A TEST WORK.

## 1

[metadata]
title = "Section 1"
breadcrumb = "Section 1"

{#title}
^1 SECT. I.

{#1}
Some objects produce immediately an agreeable sensation betwixt friends, and encrease the delicacy of passion.

{#2}
A second paragraph, identical in every edition of this work.

{#3}
A paragraph found only in the seventeen-fifty edition.

## 3

[metadata]
title = "Of Avarice"
breadcrumb = "Of Avarice"

{#1}
Avarice was withdrawn from later editions of this work.`;

const TW_1760 = `{#title}
^1 A TEST WORK.

## 1

[metadata]
title = "Section 1"
breadcrumb = "Section 1"

{#title}
^1 SECT. I.

{#1}
Some objects produce immediately an agreeable sensation between friends, and increase the delicacy of passion.

{#2}
A second paragraph, identical in every edition of this work.

## 2

[metadata]
title = "Section 2"
breadcrumb = "Section 2"

{#1}
The liberty of the press is a passion peculiar to free governments.

{#2}
Men of letters defend the natural _liberty_ of thinking<n1> in every age.

{#n1}
A remark re//42//corded at the foot of the page.`;

// A composite edition: it borrows tw's 1750 text via an angle-bracket child
// placeholder (`## <test.tw.1750>` — the bracketed id names the edition whose
// text is spliced in at that point), then adds its own inline section. The two
// child kinds mix freely in file order.
const COMP_1755 = `{#title}
^1 A COMPOSITE COLLECTION.

## <test.tw.1750>

## In

[metadata]
title = "An Inline Essay"
breadcrumb = "Inline Essay"

{#1}
An essay belonging to the composite collection alone.`;

/** The shared behavioural-test corpus, authored in memory. */
export const testCorpus = (): Record<string, string> =>
  corpus()
    .author("test", {
      forename: "Thomas",
      surname: "Test",
      birth: 1700,
      death: 1780,
      published: 1740,
      nationality: "English",
      sex: "Male",
    })
    .author("other", {
      forename: "Olivia",
      surname: "Other",
      title: "Lady Other",
      birth: 1690,
      death: 1770,
      published: 1730,
      nationality: "Scottish",
      sex: "Female",
    })
    .work("test", "solo", {
      title: "A Solitary Treatise",
      breadcrumb: "Solo Treatise",
      published: [1740],
      canonical: "1740",
    })
    .edition("test", "solo", "1740", {
      imported: true,
      title: "A Solitary Treatise",
      breadcrumb: "Solo Treatise",
      published: [1740],
    }, SOLO_1740)
    .work("test", "tw", {
      title: "A Test Work",
      breadcrumb: "Test Work",
      published: [1750, 1760],
      canonical: "1760",
      // tw is borrowed by the comp collection; it opts out of listing on its
      // own so it surfaces only within that collection (see catalog_test).
      standalone: false,
    })
    .edition("test", "tw", "1750", {
      imported: true,
      title: "A Test Work",
      breadcrumb: "Test Work",
      published: [1750],
    }, TW_1750)
    .edition("test", "tw", "1760", {
      imported: true,
      title: "A Test Work",
      breadcrumb: "Test Work",
      published: [1760],
    }, TW_1760)
    .edition("test", "tw", "main", {
      imported: true,
      title: "A Test Work",
      breadcrumb: "Test Work",
      published: [1750, 1760],
      copytext: ["1760"],
      sourceDesc: "A fixture text for the computer's tests.",
    }, TW_1760)
    .work("test", "comp", {
      title: "A Composite Collection",
      breadcrumb: "Composite",
      published: [1755],
      canonical: "1755",
    })
    .edition("test", "comp", "1755", {
      imported: true,
      title: "A Composite Collection",
      breadcrumb: "Composite",
      published: [1755],
      // a scalar copytext (not an array): the loader coerces it to a one-element
      // list, exercising the metadata-array helper's scalar arm.
      copytext: "1750",
    }, COMP_1755)
    .work("other", "stub", {
      title: "A Stub Treatise, Not Yet Transcribed",
      breadcrumb: "Stub Treatise",
      published: [1730],
      canonical: "1730",
    })
    .edition("other", "stub", "1730", {
      imported: false,
      title: "A Stub Treatise, Not Yet Transcribed",
      breadcrumb: "Stub Treatise",
      published: [1730],
    })
    .build();

/* ------------------------ the co-author corpus ----------------------- */

// A two-letter correspondence: each letter (section) overrides the work's
// `authors` with the single author who wrote it — letter 1 as an array, letter 2
// as a bare string (both forms the loader accepts).
const CORR_1700 = `{#title}
^1 A CORRESPONDENCE.

## 1

[metadata]
title = "Letter 1"
breadcrumb = "Letter 1"
authors = ["bell"]

{#1}
Dear friend, virtue and reason should guide the understanding.

## 2

[metadata]
title = "Letter 2"
breadcrumb = "Letter 2"
authors = "dee"

{#1}
Madam, liberty and passion alike move the soul.`;

/**
 * A genuinely co-authored work: "A Correspondence" lives under its host author
 * (bell, alphabetically first) but names both authors, so the catalog lists it
 * under bell and dee alike, and each letter is attributed to its writer. A
 * second work names a co-author with no author file, to drive the phantom-author
 * warning. Bell also has a solo work, so an author-scoped query has something to
 * exclude.
 */
export const coauthorCorpus = (): Record<string, string> =>
  corpus()
    .author("bell", { forename: "Anna", surname: "Bell", published: 1700 })
    .author("dee", { forename: "Carl", surname: "Dee", published: 1705 })
    .work("bell", "corr", {
      title: "A Correspondence",
      breadcrumb: "Correspondence",
      authors: ["bell", "dee"],
      published: [1700],
      canonical: "1700",
    })
    .edition("bell", "corr", "1700", {
      imported: true,
      title: "A Correspondence",
      breadcrumb: "Correspondence",
      authors: ["bell", "dee"],
      published: [1700],
    }, CORR_1700)
    .work("bell", "solo", {
      title: "A Solo Work",
      breadcrumb: "Solo",
      authors: ["bell"],
      published: [1702],
      canonical: "1702",
    })
    .edition(
      "bell",
      "solo",
      "1702",
      {
        imported: true,
        title: "A Solo Work",
        breadcrumb: "Solo",
        authors: ["bell"],
        published: [1702],
      },
      '## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\nVirtue alone.',
    )
    // names a co-author with no data/authors file: a phantom author + warning.
    .work("bell", "ghost", {
      title: "A Ghost-written Work",
      breadcrumb: "Ghost",
      authors: ["bell", "zz"],
      published: [1703],
      canonical: "1703",
    })
    .edition(
      "bell",
      "ghost",
      "1703",
      {
        imported: true,
        title: "A Ghost-written Work",
        breadcrumb: "Ghost",
        authors: ["bell", "zz"],
        published: [1703],
      },
      '## 1\n\n[metadata]\ntitle = "G"\nbreadcrumb = "G"\n\n{#1}\nReason and passion.',
    )
    .build();

/* ------------------------- the rich corpus --------------------------- */

// One paragraph exercising the whole inline vocabulary the extraction and
// diff walks recognise: every wrapper type, a two-word foreign run (so a
// diff's equal grouping compares two `language` contexts), the spacing and
// break leaves (a Markit line break is a backslash before whitespace), a page
// break, a footnote reference, an illegible gap, and the hyphen edges the
// tokenizer trims. Only the final word differs between the two editions, so the
// block diffs as one changed paragraph whose long equal run carries all that
// formatting.
const richBlock1 = (finalWord: string): string =>
  String
    .raw`Here _truly_ stands *Rome*, with $la:ipsa loquitur$ as a "maxim", ` +
  String.raw`an _em_ *st* pair and $la:una$ $de:zwei$ tongues, ` +
  String.raw`a school-men compound, a lone - mark, an abrupt- stop, an [...] ` +
  String.raw`gap,~~spaced~tight, a break\ here, a page//9//turn, a note<n1>, ` +
  `then ${finalWord}.`;

// A block of several block-level element types (a blockquote, a nested list,
// and a table), so rendering it walks every BlockElement arm and — when it is
// the block present in only one edition — the whole-block editorial marking
// walks them too, and when it differs between editions the diff's span builder
// walks them as well. The final table cell varies so the block can also serve
// as a *changed* block.
const richBlock3 = (lastCell: string): string =>
  `> A quoted line one.
>
> A quoted line two.

- alpha
- beta
  - beta-i
  - beta-ii
- gamma

| Apple | Pear |
|-------|------|
| Plum | ${lastCell} |
|  | gap |`;

// Word pairs that drive the lemmatiser's suffix rules: each inflected form
// sits beside the base it should resolve to (and a few -er/-es/-st cases where
// only the silent-e base is present, exercising the "+e" arms — e.g. lov'st →
// love).
const lemmaWords = [
  "running run causing cause trying try tried tries greatest great",
  "doeth do causeth pleased please called call speaker speak larger large",
  "boxes box names name naturally natural wouldst would love lov'st",
  "witnesses agreed freed hopping filing controlling duties happiness",
].join(" ") + ".";

// Section 2 differs between the editions only in two small paragraphs, chosen to
// drive the word-diff: {#3} has a common subsequence with edits on both sides
// (exercising the Myers backtrack), and {#4} is a pure middle insertion.
const richEdition = (variant: "first" | "second") => {
  const final = variant === "first" ? "ALPHA" : "OMEGA";
  // The block present in only this edition, and (for the first) a subtitle whose
  // heading the whole-block marking must walk when it is deleted in the diff.
  const onlyBlock = variant === "first"
    ? `{#subtitle}
^2 A MARGINAL HEADING

{#3}
${richBlock3("Fig")}`
    : `{#4}
${richBlock3("Fig")}`;
  const ownSection = variant === "first"
    ? `## 3

[metadata]
title = "First Only"
breadcrumb = "First Only"

{#1}
This whole section exists only in the first edition.`
    : `## 4

[metadata]
title = "Second Only"
breadcrumb = "Second Only"

{#1}
This whole section exists only in the second edition.`;
  const myers = variant === "first"
    ? "alpha beta gamma delta"
    : "alpha gamma zeta delta";
  const inserted = variant === "first" ? "one three" : "one two three";
  // A subtitle whose heading differs, and a rich multi-element block whose last
  // cell differs: both diff as *changed* blocks, so the diff's span builder
  // walks a heading and the blockquote/list/table arms.
  const subhead = variant === "first" ? "ONE" : "TWO";
  const richDiffCell = variant === "first" ? "Fig" : "Date";
  return `{#title}
^2 AN
^1 ANTHOLOGY

## 1

[metadata]
title = "Of Forms"
breadcrumb = "Of Forms"

{#1}
${richBlock1(final)}

{#2}
The clerk [-mistook-][+corrected+] the entry and [+also+] signed it.

${onlyBlock}

{#n1}
A footnote at the foot of the page.

## 2

[metadata]
title = "Of Words"
breadcrumb = "Of Words"

{#1}
${lemmaWords}

{#hl}
The liberty here stands firm, yet _truly_ the liberty there endures.

{#echo}
echo echo echo echo at the close.

{#subtitle}
^3 SECTION
^2 HEADING ${subhead}

{#myers}
${myers}

{#ins}
${inserted}

{#richdiff}
${richBlock3(richDiffCell)}

${ownSection}`;
};

/**
 * A second corpus, exercising the full Markit inline/block vocabulary and a
 * two-edition word diff. Author "rich" has one work "anth" with editions 1700
 * and 1710 that share sections 1 and 2 (so a section comparison has a
 * neighbour in both) and each carry one section of their own (so a work
 * comparison aligns added/removed sections). Section 1 holds the rich block
 * that diffs as a single changed paragraph plus blocks present in only one
 * edition; section 2 holds the lemmatiser word bag and a few small paragraphs
 * tuned to drive the word diff and the search highlighter.
 */
export const richCorpus = (): Record<string, string> =>
  corpus()
    .author("rich", {
      forename: "Rachel",
      surname: "Rich",
      birth: 1690,
      death: 1760,
      published: 1700,
      nationality: "English",
      sex: "Female",
    })
    .work("rich", "anth", {
      title: "An Anthology",
      breadcrumb: "Anthology",
      published: [1700, 1710],
      canonical: "1710",
    })
    .edition("rich", "anth", "1700", {
      imported: true,
      title: "An Anthology",
      breadcrumb: "Anthology",
      published: [1700],
    }, richEdition("first"))
    .edition("rich", "anth", "1710", {
      imported: true,
      title: "An Anthology",
      breadcrumb: "Anthology",
      published: [1710],
    }, richEdition("second"))
    .build();

/** A long paragraph of `n` unique tokens, all sharing a prefix. */
const uniqueWords = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

/**
 * A corpus whose two editions share a block id but fill it with wholly
 * disjoint text long enough that the word diff exceeds its edit-distance
 * ceiling and falls back to delete-all/insert-all.
 */
export const bigDiffCorpus = (): Record<string, string> =>
  corpus()
    .author("big", { forename: "Barnaby", surname: "Big" })
    .work("big", "tome", {
      title: "A Tome",
      breadcrumb: "Tome",
      published: [1700, 1710],
      canonical: "1710",
    })
    .edition(
      "big",
      "tome",
      "1700",
      {
        imported: true,
        title: "A Tome",
        breadcrumb: "Tome",
        published: [1700],
      },
      `## 1\n\n[metadata]\ntitle = "One"\nbreadcrumb = "One"\n\n{#1}\n${
        uniqueWords("alpha", 1600)
      }`,
    )
    .edition(
      "big",
      "tome",
      "1710",
      {
        imported: true,
        title: "A Tome",
        breadcrumb: "Tome",
        published: [1710],
      },
      `## 1\n\n[metadata]\ntitle = "One"\nbreadcrumb = "One"\n\n{#1}\n${
        uniqueWords("omega", 1600)
      }`,
    )
    .build();

/** A two-author corpus where both authors have a transcribed work sharing a
 * word, so an author-scoped count must exclude the other author's editions. */
export const openableTwoAuthor = (): Record<string, string> => {
  const body = (line: string) =>
    `## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\n${line}`;
  return corpus()
    .author("a", { forename: "Ann", surname: "Aa", published: 1700 })
    .author("b", { forename: "Ben", surname: "Bb", published: 1710 })
    .work("a", "w", {
      title: "Wa",
      breadcrumb: "Wa",
      published: [1700],
      canonical: "1700",
    })
    .edition("a", "w", "1700", {
      imported: true,
      title: "Wa",
      breadcrumb: "Wa",
      published: [1700],
    }, body("shared virtue dwells here among friends."))
    .work("b", "x", {
      title: "Xb",
      breadcrumb: "Xb",
      published: [1710],
      canonical: "1710",
    })
    .edition("b", "x", "1710", {
      imported: true,
      title: "Xb",
      breadcrumb: "Xb",
      published: [1710],
    }, body("shared virtue lingers there among strangers."))
    .build();
};

/** A corpus with no imported text at all (only an un-transcribed stub). */
export const emptyCorpus = (): Record<string, string> =>
  corpus()
    .author("void", { forename: "Vera", surname: "Void" })
    .work("void", "stub", {
      title: "An Untranscribed Work",
      breadcrumb: "Untranscribed",
      published: [1700],
      canonical: "1700",
    })
    .edition("void", "stub", "1700", {
      imported: false,
      title: "An Untranscribed Work",
      breadcrumb: "Untranscribed",
      published: [1700],
    })
    .build();

/* ---------------------- branch-coverage corpora ---------------------- */

/**
 * Sparse and irregular metadata, to drive the catalog's and renderer's
 * fallback branches: an author with a birth but no death and a single work; an
 * author with no metadata at all; a work whose index omits title/breadcrumb/
 * published; an edition with empty metadata; a year-named directory edition; a
 * work whose publication list is empty.
 */
export const metadataCorpus = (): Record<string, string> => {
  const section = '\n\n## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n' +
    "{#1}\nA short sentence of text.";
  return corpus()
    // birth but no death; nationality/sex/published set; a single work.
    .file(
      "data/authors/alpha.mit",
      '# alpha\n\n[metadata]\nforename = "Al"\nsurname = "Pha"\nbirth = 1700\n' +
        'published = 1700\nnationality = "English"\nsex = "Male"\n',
    )
    // no metadata at all: forename/surname/published all absent.
    .file("data/authors/min.mit", "# min\n")
    // a death but no birth (the other side of the date-span fallback).
    // published year ties with alpha, so the author sort falls to its slug
    // tiebreak; the death-without-birth feeds the other date-span fallback.
    .file(
      "data/authors/gamma.mit",
      '# gamma\n\n[metadata]\nforename = "Ga"\nsurname = "Mma"\ndeath = 1799\n' +
        "published = 1700\n",
    )
    .file(
      "data/works/gamma/g/index.mit",
      '# gamma.g\n\n[metadata]\ntitle = "G"\nbreadcrumb = "G"\n' +
        'published = [1700]\ncanonical = "1700"\n',
    )
    .file(
      "data/works/gamma/g/1700.mit",
      '# gamma.g.1700\n\n[metadata]\ntitle = "G"\nbreadcrumb = "G"\n' +
        "imported = true\npublished = [1700]" + section,
    )
    // alpha/a: full work, a normal edition, and a directory-style edition.
    .file(
      "data/works/alpha/a/index.mit",
      '# alpha.a\n\n[metadata]\ntitle = "A"\nbreadcrumb = "A"\n' +
        'published = [1700]\ncanonical = "1700"\n',
    )
    .file(
      "data/works/alpha/a/1700.mit",
      '# alpha.a.1700\n\n[metadata]\ntitle = "A"\nbreadcrumb = "A"\n' +
        "imported = true\npublished = [1700]" + section,
    )
    .file(
      "data/works/alpha/a/1758/index.mit",
      '# alpha.a.1758\n\n[metadata]\ntitle = "A"\nbreadcrumb = "A"\n' +
        "imported = true\npublished = [1758]" + section,
    )
    // a non-.mit file inside the work folder (the edition scan ignores it).
    .file("data/works/alpha/a/readme.txt", "notes, not an edition")
    // alpha/b and alpha/c: two works with empty publication lists, so the work
    // sort compares two missing years (and a missing against a present one).
    .file(
      "data/works/alpha/b/index.mit",
      '# alpha.b\n\n[metadata]\ntitle = "B"\nbreadcrumb = "B"\ncanonical = "1700"\n',
    )
    .file(
      "data/works/alpha/b/1700.mit",
      '# alpha.b.1700\n\n[metadata]\ntitle = "B"\nbreadcrumb = "B"\nimported = true' +
        section,
    )
    .file(
      "data/works/alpha/c/index.mit",
      '# alpha.c\n\n[metadata]\ntitle = "C"\nbreadcrumb = "C"\ncanonical = "1700"\n',
    )
    .file(
      "data/works/alpha/c/1700.mit",
      '# alpha.c.1700\n\n[metadata]\ntitle = "C"\nbreadcrumb = "C"\nimported = true' +
        section,
    )
    // min/w: index without title/breadcrumb/published; an edition with empty
    // metadata (no title/breadcrumb/imported/published).
    .file("data/works/min/w/index.mit", "# min.w\n")
    .file(
      "data/works/min/w/1700.mit",
      "# min.w.1700\n\n[metadata]\n" + section,
    )
    .build();
};

/**
 * A work with real text and a work whose only edition is imported but empty
 * (no content blocks), so the build produces a zero-vector document and a
 * zero-mass topic mix, and the similarity scan meets a candidate with no
 * shared vocabulary.
 */
export const emptyDocCorpus = (): Record<string, string> =>
  corpus()
    .author("solid", { forename: "Sol", surname: "Id", published: 1700 })
    .work("solid", "real", {
      title: "Real",
      breadcrumb: "Real",
      published: [1700],
      canonical: "1700",
    })
    .edition(
      "solid",
      "real",
      "1700",
      {
        imported: true,
        title: "Real",
        breadcrumb: "Real",
        published: [1700],
      },
      '## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\nphilosophy virtue reason nature passion liberty understanding.',
    )
    .work("solid", "hollow", {
      title: "Hollow",
      breadcrumb: "Hollow",
      published: [1710],
      canonical: "1710",
    })
    // imported (the metadata says so) but with no content blocks at all.
    .file(
      "data/works/solid/hollow/1710.mit",
      '# solid.hollow.1710\n\n[metadata]\ntitle = "Hollow"\nbreadcrumb = "Hollow"\n' +
        "imported = true\npublished = [1710]\n",
    )
    .build();

/**
 * A two-edition work whose section has subsections present in both editions,
 * so a section comparison reports child rows (and the section comparison's
 * neighbour search and matching-edition list have something to find).
 */
export const subsectionCompareCorpus = (): Record<string, string> => {
  const body = (extra: string) =>
    `## 1\n\n[metadata]\ntitle = "One"\nbreadcrumb = "One"\n\n{#1}\nShared opening ${extra}.\n\n` +
    `### a\n\n[metadata]\ntitle = "Sub A"\nbreadcrumb = "Sub A"\n\n{#1}\nSubsection ${extra} text.`;
  return corpus()
    .author("pair", { forename: "Pa", surname: "Ir", published: 1700 })
    .work("pair", "w", {
      title: "Paired",
      breadcrumb: "Paired",
      published: [1700, 1710],
      canonical: "1710",
    })
    .edition("pair", "w", "1700", {
      imported: true,
      title: "Paired",
      breadcrumb: "Paired",
      published: [1700],
    }, body("first"))
    .edition("pair", "w", "1710", {
      imported: true,
      title: "Paired",
      breadcrumb: "Paired",
      published: [1710],
    }, body("second"))
    .build();
};

/**
 * A corpus tuned for the similarity and topic vector branches: a target work, a
 * candidate sharing no vocabulary (zero dot product), a candidate whose only
 * block has no word tokens (zero norm — also a zero-mass topic document), and
 * two identical candidates (equal similarity and topic weight, so the sorts
 * fall to their tiebreaks).
 */
export const vectorCorpus = (): Record<string, string> => {
  const sec = (words: string) =>
    `## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\n${words}`;
  return corpus()
    .author("vec", { forename: "Vee", surname: "Ctor", published: 1700 })
    .work("vec", "target", {
      title: "T",
      breadcrumb: "T",
      published: [1700],
      canonical: "1700",
    })
    .edition(
      "vec",
      "target",
      "1700",
      { imported: true, title: "T", breadcrumb: "T", published: [1700] },
      sec(
        "philosophy virtue reason nature passion liberty understanding cause effect",
      ),
    )
    .work("vec", "disjoint", {
      title: "D",
      breadcrumb: "D",
      published: [1700],
      canonical: "1700",
    })
    .edition("vec", "disjoint", "1700", {
      imported: true,
      title: "D",
      breadcrumb: "D",
      published: [1700],
    }, sec("kappa lambda mu nu omicron sigma tau upsilon"))
    .work("vec", "hollow", {
      title: "H",
      breadcrumb: "H",
      published: [1700],
      canonical: "1700",
    })
    .edition("vec", "hollow", "1700", {
      imported: true,
      title: "H",
      breadcrumb: "H",
      published: [1700],
    }, sec("[...]"))
    .work("vec", "twinA", {
      title: "TA",
      breadcrumb: "TA",
      published: [1700],
      canonical: "1700",
    })
    .edition("vec", "twinA", "1700", {
      imported: true,
      title: "TA",
      breadcrumb: "TA",
      published: [1700],
    }, sec("virtue reason cause"))
    .work("vec", "twinB", {
      title: "TB",
      breadcrumb: "TB",
      published: [1700],
      canonical: "1700",
    })
    .edition("vec", "twinB", "1700", {
      imported: true,
      title: "TB",
      breadcrumb: "TB",
      published: [1700],
    }, sec("virtue reason cause"))
    .build();
};

/**
 * Several works built from a single shared lemma, so the topic model collapses
 * to one topic in which every work has weight 1 — the prominent-works sort then
 * exercises its tiebreak.
 */
export const oneTopicCorpus = (): Record<string, string> => {
  const one =
    '## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\nphilosophy philosophy philosophy.';
  return corpus()
    .author("one", { forename: "On", surname: "E", published: 1700 })
    .work("one", "a", {
      title: "A",
      breadcrumb: "A",
      published: [1700],
      canonical: "1700",
    })
    .edition("one", "a", "1700", {
      imported: true,
      title: "A",
      breadcrumb: "A",
      published: [1700],
    }, one)
    .work("one", "b", {
      title: "B",
      breadcrumb: "B",
      published: [1700],
      canonical: "1700",
    })
    .edition("one", "b", "1700", {
      imported: true,
      title: "B",
      breadcrumb: "B",
      published: [1700],
    }, one)
    .work("one", "c", {
      title: "C",
      breadcrumb: "C",
      published: [1700],
      canonical: "1700",
    })
    .edition("one", "c", "1700", {
      imported: true,
      title: "C",
      breadcrumb: "C",
      published: [1700],
    }, one)
    .build();
};

/**
 * A target section and two candidate sections that share its vocabulary — one
 * with a title, one without — so section-level similarity returns a result both
 * with and without a section title.
 */
export const sectionSimilarCorpus = (): Record<string, string> => {
  const ed = (id: string, title: string, words: string) =>
    `# ${id}\n\n[metadata]\ntitle = "W"\nbreadcrumb = "W"\nimported = true\n` +
    `published = [1700]\n\n## 1\n\n[metadata]\n${title}breadcrumb = "x"\n\n{#1}\n${words}`;
  const idx = (id: string) =>
    `# ${id}\n\n[metadata]\ntitle = "W"\nbreadcrumb = "W"\npublished = [1700]\ncanonical = "1700"\n`;
  return corpus()
    .author("sec", { forename: "Se", surname: "C", published: 1700 })
    .file("data/works/sec/tgt/index.mit", idx("sec.tgt"))
    .file(
      "data/works/sec/tgt/1700.mit",
      ed("sec.tgt.1700", 'title = "T"\n', "alpha beta gamma delta epsilon"),
    )
    .file("data/works/sec/titled/index.mit", idx("sec.titled"))
    .file(
      "data/works/sec/titled/1700.mit",
      ed("sec.titled.1700", 'title = "Titled"\n', "alpha beta gamma zeta"),
    )
    .file("data/works/sec/bare/index.mit", idx("sec.bare"))
    // the section has no title metadata, so a result for it has a null title.
    .file(
      "data/works/sec/bare/1700.mit",
      ed("sec.bare.1700", "", "alpha beta delta eta"),
    )
    .build();
};
