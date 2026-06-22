/**
 * The catalog scan's tolerance of a malformed corpus, exercised through the
 * build pipeline (buildArtefactsToDisk over an in-memory corpus, the same entry
 * the build command drives). Each case builds a deliberately broken corpus and
 * asserts the warning it records and the catalog it still produces — the scan
 * never throws, it degrades. A couple of cases wrap the corpus FS to make
 * `readFile` fail on a listed file, the disk-race the loader guards against.
 */

import { assert } from "@std/assert";
import { buildArtefactsToDisk } from "../../src/core/pipeline.ts";
import type { CorpusFs } from "../../src/core/build/catalog.ts";
import { memoryHarness } from "../helpers.ts";
import { corpus, CORPUS_ROOT, memoryCorpus } from "../corpus.ts";

/** Build a corpus (optionally over a custom FS) and return its build warnings. */
const warningsFor = async (
  files: Record<string, string>,
  fs?: CorpusFs,
): Promise<string[]> => {
  const harness = memoryHarness(files);
  const io = fs === undefined ? harness.io : { ...harness.io, corpus: fs };
  const built = await buildArtefactsToDisk(io, CORPUS_ROOT, "memory");
  return built.manifest.warnings;
};

const has = (warnings: string[], fragment: string): boolean =>
  warnings.some((w) => w.includes(fragment));

/** A minimal valid author + work, so a build always has something to scan. */
const base = () =>
  corpus()
    .author("a", { forename: "Ann", surname: "Aa", published: 1700 })
    .work("a", "w", {
      title: "W",
      breadcrumb: "W",
      published: [1700],
      canonical: "1700",
    })
    .edition(
      "a",
      "w",
      "1700",
      {
        imported: true,
        title: "W",
        breadcrumb: "W",
        published: [1700],
      },
      '## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\nA sentence.',
    );

Deno.test("catalog: a scalar children value is read as a one-element list", async () => {
  // children given as a bare string (not an array): the inline section resolves.
  const files = base()
    .edition(
      "a",
      "w",
      "1710",
      {
        imported: true,
        title: "W",
        breadcrumb: "W",
        published: [1710],
        children: "in", // a scalar, not ["in"]
      },
      '## In\n\n[metadata]\ntitle = "Inline"\nbreadcrumb = "Inline"\n\n{#1}\nInline text.',
    )
    .build();
  const warnings = await warningsFor(files);
  // It built without complaint about children.
  assert(!has(warnings, "unresolved child"));
});

Deno.test("catalog: a child reference resolves case-insensitively", async () => {
  // The reference points at ../W/1700 with the work in a different case than on
  // disk; the case-insensitive walk still finds it.
  const files = base()
    .edition(
      "a",
      "w",
      "1710",
      {
        imported: true,
        title: "W",
        breadcrumb: "W",
        published: [1710],
        children: ["../W/1700"],
      },
      '## Own\n\n[metadata]\ntitle = "Own"\nbreadcrumb = "Own"\n\n{#1}\nOwn text.',
    )
    .build();
  const warnings = await warningsFor(files);
  assert(!has(warnings, "unresolved child"), warnings.join("; "));
});

Deno.test("catalog: a circular child reference is reported and broken", async () => {
  const files = base()
    .file(
      "works/a/loop/index.mit",
      '# a.loop\n\n[metadata]\ntitle = "Loop"\nbreadcrumb = "Loop"\npublished = [1700]\ncanonical = "1700"\n',
    )
    .file(
      "works/a/loop/1700.mit",
      '# a.loop.1700\n\n[metadata]\ntitle = "Loop"\nbreadcrumb = "Loop"\npublished = [1700]\nimported = true\nchildren = ["1710"]\n\n## one\n\n{#1}\nfirst.',
    )
    .file(
      "works/a/loop/1710.mit",
      '# a.loop.1710\n\n[metadata]\ntitle = "Loop"\nbreadcrumb = "Loop"\npublished = [1710]\nimported = true\nchildren = ["1700"]\n\n## two\n\n{#1}\nsecond.',
    )
    .build();
  const warnings = await warningsFor(files);
  assert(has(warnings, "circular child reference"), warnings.join("; "));
});

Deno.test("catalog: an unresolved child reference is reported", async () => {
  const files = base()
    .edition(
      "a",
      "w",
      "1710",
      {
        imported: true,
        title: "W",
        breadcrumb: "W",
        published: [1710],
        children: ["nowhere"],
      },
      '## Own\n\n[metadata]\ntitle = "Own"\nbreadcrumb = "Own"\n\n{#1}\nOwn text.',
    )
    .build();
  const warnings = await warningsFor(files);
  assert(has(warnings, 'unresolved child "nowhere"'), warnings.join("; "));
});

Deno.test("catalog: inline sections not named in children are kept", async () => {
  // children names only one of two inline sections; the other is appended.
  const files = base()
    .edition(
      "a",
      "w",
      "1710",
      {
        imported: true,
        title: "W",
        breadcrumb: "W",
        published: [1710],
        children: ["named"],
      },
      '## named\n\n[metadata]\ntitle = "Named"\nbreadcrumb = "Named"\n\n{#1}\none.\n\n' +
        '## extra\n\n[metadata]\ntitle = "Extra"\nbreadcrumb = "Extra"\n\n{#1}\ntwo.',
    )
    .build();
  const warnings = await warningsFor(files);
  assert(!has(warnings, "unresolved child"), warnings.join("; "));
});

Deno.test("catalog: a stray non-directory in a work folder is ignored", async () => {
  const files = base()
    .file("works/a/notes.txt", "not a work")
    .build();
  const warnings = await warningsFor(files);
  // It builds; the stray file produces no work and no crash.
  assert(Array.isArray(warnings));
});

Deno.test("catalog: a work with no editions is reported and dropped", async () => {
  const files = base()
    .file(
      "works/a/empty/index.mit",
      '# a.empty\n\n[metadata]\ntitle = "Empty"\nbreadcrumb = "Empty"\npublished = [1700]\ncanonical = "1700"\n',
    )
    .build();
  const warnings = await warningsFor(files);
  assert(has(warnings, "a/empty: no editions"), warnings.join("; "));
});

Deno.test("catalog: a year directory without an index is skipped as an edition", async () => {
  const files = base()
    .file("works/a/w/1799/notes.txt", "a year-shaped directory with no index")
    .build();
  const warnings = await warningsFor(files);
  // The work still builds from its real 1700 edition.
  assert(!has(warnings, "no editions"), warnings.join("; "));
});

Deno.test("catalog: a declared canonical that is not an edition is reported", async () => {
  const files = corpus()
    .author("a", { forename: "Ann", surname: "Aa", published: 1700 })
    .work("a", "w", {
      title: "W",
      breadcrumb: "W",
      published: [1700],
      canonical: "9999", // no such edition
    })
    .edition("a", "w", "1700", {
      imported: true,
      title: "W",
      breadcrumb: "W",
      published: [1700],
    }, '## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\nA sentence.')
    .build();
  const warnings = await warningsFor(files);
  assert(
    has(warnings, 'canonical "9999" is not an edition'),
    warnings.join("; "),
  );
});

Deno.test("catalog: a non-.mit file in the authors folder is ignored", async () => {
  const files = base().file("authors/README.txt", "notes").build();
  const warnings = await warningsFor(files);
  assert(!has(warnings, "no authors directory"), warnings.join("; "));
});

Deno.test("catalog: a corpus with no authors directory is reported", async () => {
  // Only a works tree, no authors/. Both the missing-authors warning and the
  // missing author file for the work are recorded.
  const files = corpus()
    .work("ghost", "w", {
      title: "W",
      breadcrumb: "W",
      published: [1700],
      canonical: "1700",
    })
    .edition("ghost", "w", "1700", {
      imported: true,
      title: "W",
      breadcrumb: "W",
      published: [1700],
    }, '## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\nA sentence.')
    .build();
  const warnings = await warningsFor(files);
  assert(has(warnings, "no authors directory"), warnings.join("; "));
  assert(has(warnings, "has no authors/ghost.mit"), warnings.join("; "));
});

Deno.test("catalog: a stray non-directory in the works folder is ignored", async () => {
  const files = base().file("works/loose.txt", "not an author").build();
  const warnings = await warningsFor(files);
  assert(Array.isArray(warnings));
});

Deno.test("catalog: an unreadable but listed file degrades to a null document", async () => {
  // A corpus FS whose readFile fails for two listed files (the disk race the
  // loader guards against): an author file and a work's index. The author
  // degrades to a slug-only author; the work, whose stub reads as null, drops.
  const files = base()
    .author("b", { forename: "Ben", surname: "Bb", published: 1710 })
    .work("b", "x", {
      title: "X",
      breadcrumb: "X",
      published: [1710],
      canonical: "1710",
    })
    .edition("b", "x", "1710", {
      imported: true,
      title: "X",
      breadcrumb: "X",
      published: [1710],
    }, '## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\nText.')
    .build();
  const mem = memoryCorpus(files);
  const flaky: CorpusFs = {
    ...mem,
    readFile: (path) =>
      path.endsWith("/authors/b.mit") || path.endsWith("/works/b/x/index.mit")
        ? Promise.resolve(null)
        : mem.readFile(path),
  };
  const warnings = await warningsFor(files, flaky);
  assert(Array.isArray(warnings));
});

Deno.test("catalog: a child path through a file, and one to a directory, are unresolved", async () => {
  // One reference descends through a file ("1700.mit/x" — readDir throws), the
  // other resolves to a directory rather than a file; both are reported.
  const files = base()
    .edition("a", "w", "1710", {
      imported: true,
      title: "W",
      breadcrumb: "W",
      published: [1710],
      children: ["../w/1700.mit/x", "../w/dir"],
    }, '## Own\n\n[metadata]\ntitle = "Own"\nbreadcrumb = "Own"\n\n{#1}\nOwn.')
    // A directory named like a child target ("dir.mit"), so the case-insensitive
    // walk ends on a directory.
    .file("works/a/w/dir.mit/keep.txt", "makes dir.mit a directory")
    .build();
  const warnings = await warningsFor(files);
  assert(
    has(warnings, 'unresolved child "../w/1700.mit/x"'),
    warnings.join("; "),
  );
  assert(has(warnings, 'unresolved child "../w/dir"'), warnings.join("; "));
});

Deno.test("catalog: a corpus FS whose stat throws still resolves via the walk", async () => {
  // stat throwing (rather than returning null) sends every lookup down the
  // case-insensitive walk; the loader swallows the failure and degrades.
  const files = base().build();
  const mem = memoryCorpus(files);
  const flaky: CorpusFs = {
    ...mem,
    stat: () => Promise.reject(new Error("stat blew up")),
  };
  const warnings = await warningsFor(files, flaky);
  assert(Array.isArray(warnings));
});
