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

/** Normalise a path textually, resolving "." and ".." (as the catalog does). */
const normalizePath = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + out.join("/");
};

/* ------------------------------ corpus FS ----------------------------- */

/** A `CorpusFs` over a (possibly mutable) map of normalised path → file text. */
export const memoryCorpus = (files: Record<string, string>): CorpusFs => ({
  readFile: (path) => Promise.resolve(files[normalizePath(path)] ?? null),
  readDir: (path) => {
    const prefix = normalizePath(path) + "/";
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

  /** `authors/<slug>.mit`: the author's metadata (no text). */
  author(slug: string, meta: Meta): this {
    this.files[`${CORPUS_ROOT}/authors/${slug}.mit`] = doc(`# ${slug}`, meta);
    return this;
  }

  /** `works/<author>/<work>/index.mit`: the work's edition-independent identity. */
  work(author: string, work: string, meta: Meta): this {
    this.files[`${CORPUS_ROOT}/works/${author}/${work}/index.mit`] = doc(
      `# ${author}.${work}`,
      meta,
    );
    return this;
  }

  /** `works/<author>/<work>/<slug>.mit`: a year-named edition with its text. */
  edition(
    author: string,
    work: string,
    slug: string,
    meta: Meta,
    body = "",
  ): this {
    this.files[`${CORPUS_ROOT}/works/${author}/${work}/${slug}.mit`] = doc(
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

const COMP_1755 = `{#title}
^1 A COMPOSITE COLLECTION.

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
      children: ["../tw/1750", "in"],
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
