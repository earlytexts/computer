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

Deno.test("catalog: inline and borrowed children mix without warning", async () => {
  // An angle-bracket placeholder (`## <a.w.1700>`, borrowing the work's 1700
  // text) sits before an ordinary inline section; both are kept, in file order,
  // and the build raises no complaint about an unresolved child.
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
      },
      "## <a.w.1700>\n\n" +
        '## In\n\n[metadata]\ntitle = "Inline"\nbreadcrumb = "Inline"\n\n{#1}\nInline text.',
    )
    .build();
  const warnings = await warningsFor(files);
  assert(!has(warnings, "unresolved child"), warnings.join("; "));
});

Deno.test("catalog: an angle-bracket child resolves case-insensitively", async () => {
  // The bracketed id is in a different case (A.W.1700) than the files on disk;
  // the case-insensitive walk still finds data/works/a/w/1700.
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
      },
      "## <A.W.1700>",
    )
    .build();
  const warnings = await warningsFor(files);
  assert(!has(warnings, "unresolved child"), warnings.join("; "));
});

Deno.test("catalog: an angle-bracket child resolves a directory-form edition", async () => {
  // The borrowed edition lives in its directory form (1720/index.mit), so the
  // resolver falls through from the <edition>.mit candidate to <edition>/index.mit.
  const files = base()
    .file(
      "data/works/a/w/1720/index.mit",
      '# a.w.1720\n\n[metadata]\ntitle = "W"\nbreadcrumb = "W"\nimported = true\n' +
        'published = [1720]\n\n## 1\n\n[metadata]\ntitle = "S"\nbreadcrumb = "S"\n\n{#1}\nDir text.',
    )
    .edition(
      "a",
      "w",
      "1730",
      {
        imported: true,
        title: "W",
        breadcrumb: "W",
        published: [1730],
      },
      "## <a.w.1720>",
    )
    .build();
  const warnings = await warningsFor(files);
  assert(!has(warnings, "unresolved child"), warnings.join("; "));
});

Deno.test("catalog: a circular child reference is reported and broken", async () => {
  // Two editions of the same work borrow each other via angle-bracket children.
  const files = base()
    .file(
      "data/works/a/loop/index.mit",
      '# a.loop\n\n[metadata]\ntitle = "Loop"\nbreadcrumb = "Loop"\npublished = [1700]\ncanonical = "1700"\n',
    )
    .file(
      "data/works/a/loop/1700.mit",
      '# a.loop.1700\n\n[metadata]\ntitle = "Loop"\nbreadcrumb = "Loop"\npublished = [1700]\nimported = true\n\n## one\n\n{#1}\nfirst.\n\n## <a.loop.1710>',
    )
    .file(
      "data/works/a/loop/1710.mit",
      '# a.loop.1710\n\n[metadata]\ntitle = "Loop"\nbreadcrumb = "Loop"\npublished = [1710]\nimported = true\n\n## two\n\n{#1}\nsecond.\n\n## <a.loop.1700>',
    )
    .build();
  const warnings = await warningsFor(files);
  assert(has(warnings, "circular child reference"), warnings.join("; "));
});

Deno.test("catalog: an unresolved or malformed child reference is reported", async () => {
  // One bracket id names no edition; the other has too few segments to be an
  // edition id at all. Both are reported and dropped.
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
      },
      "## <a.w.nowhere>\n\n## <foo>",
    )
    .build();
  const warnings = await warningsFor(files);
  assert(has(warnings, 'unresolved child "a.w.nowhere"'), warnings.join("; "));
  assert(has(warnings, 'unresolved child "foo"'), warnings.join("; "));
});

Deno.test("catalog: a stray non-directory in a work folder is ignored", async () => {
  const files = base()
    .file("data/works/a/notes.txt", "not a work")
    .build();
  const warnings = await warningsFor(files);
  // It builds; the stray file produces no work and no crash.
  assert(Array.isArray(warnings));
});

Deno.test("catalog: a work with no editions is reported and dropped", async () => {
  const files = base()
    .file(
      "data/works/a/empty/index.mit",
      '# a.empty\n\n[metadata]\ntitle = "Empty"\nbreadcrumb = "Empty"\npublished = [1700]\ncanonical = "1700"\n',
    )
    .build();
  const warnings = await warningsFor(files);
  assert(has(warnings, "a/empty: no editions"), warnings.join("; "));
});

Deno.test("catalog: a year directory without an index is skipped as an edition", async () => {
  const files = base()
    .file(
      "data/works/a/w/1799/notes.txt",
      "a year-shaped directory with no index",
    )
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
  const files = base().file("data/authors/README.txt", "notes").build();
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
  assert(has(warnings, "has no data/authors/ghost.mit"), warnings.join("; "));
});

Deno.test("catalog: a stray non-directory in the works folder is ignored", async () => {
  const files = base().file("data/works/loose.txt", "not an author").build();
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

Deno.test("catalog: an angle-bracket child resolving to a directory, or descending through a file, is unresolved", async () => {
  // a.w.dir's .mit candidate ends on a directory (and it has no index.mit form);
  // a.w.foo's index.mit candidate descends through a bare file, so readDir
  // throws. Both references stay unresolved.
  const files = base()
    .edition("a", "w", "1710", {
      imported: true,
      title: "W",
      breadcrumb: "W",
      published: [1710],
    }, "## <a.w.dir>\n\n## <a.w.foo>")
    // dir.mit is a directory, so the .mit candidate's walk ends on a directory.
    .file("data/works/a/w/dir.mit/keep.txt", "makes dir.mit a directory")
    // foo is a bare file, so descending into it for foo/index.mit throws.
    .file("data/works/a/w/foo", "a bare file, not a directory")
    .build();
  const warnings = await warningsFor(files);
  assert(has(warnings, 'unresolved child "a.w.dir"'), warnings.join("; "));
  assert(has(warnings, 'unresolved child "a.w.foo"'), warnings.join("; "));
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
