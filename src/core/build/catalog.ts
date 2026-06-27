/**
 * The catalog scans the corpus, compiles every Markit file, and organises the
 * results into authors, works, and editions.
 *
 * Corpus layout (see corpus/README.md):
 *  - `data/authors/<author>.mit` holds an author's metadata (no text).
 *  - `data/works/<author>/<work>/` is a work. Its `index.mit` is a metadata-only
 *    stub: the work's edition-independent identity (title, breadcrumb,
 *    published) plus a `canonical` key naming the default edition. The texts
 *    are year-named editions — sibling entries whose names look like years
 *    (`1757.mit`, `1742a.mit`, or directories `1758/index.mit`). A `main.mit`
 *    sibling (the retained old reading text) is kept but never exposed.
 *  - A document's children are its inline `##` sections, in file order. A
 *    section whose id is wrapped in angle brackets — e.g. `## <Hume.EHU.1750>`
 *    — is a borrowed child: a placeholder naming another edition by id, which
 *    is loaded recursively and spliced in at that point. Inline and borrowed
 *    children mix freely, letting composite works (collections like ETSS, FD,
 *    HE) interleave their own sections with text shared from other works.
 *  - Cascading metadata (imported, published, copytext, sourceUrl,
 *    sourceDesc) flows down the composed tree: a section without the key
 *    takes the nearest ancestor's value.
 */

import { compile, type MarkitDocument } from "@earlytexts/markit";

/**
 * The filesystem capability the catalog scan needs. The corpus file set is
 * discovered by parsing (children references, case-insensitive lookups), so the
 * I/O cannot be hoisted ahead of the walk — it is injected as this port instead.
 * The io adapter supplies the Deno-backed implementation; tests an in-memory one.
 * `readFile` and `stat` return null when the path is absent; `readDir` throws
 * (as Deno.readDir does) so a missing corpus directory surfaces.
 */
export interface CorpusFs {
  readFile(path: string): Promise<string | null>;
  readDir(path: string): Promise<Deno.DirEntry[]>;
  realPath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile: boolean } | null>;
}

export type Author = {
  slug: string;
  forename: string;
  surname: string;
  title?: string; // honorific, e.g. "Lord Kames"
  birth?: number;
  death?: number;
  published?: number; // year of first publication; used for ordering
  nationality?: string;
  sex?: string;
  works: Work[]; // ascending by first publication year
};

export type Edition = {
  /** Author slugs, in title order; [0] is the host (the directory it lives in). */
  authorSlugs: string[];
  workSlug: string;
  slug: string; // a year slug, e.g. "1757", "1742a"
  title: string;
  breadcrumb: string;
  imported: boolean;
  published: number[];
  copytext: string[];
  sourceUrl?: string;
  sourceDesc?: string;
  document: MarkitDocument;
};

export type Work = {
  /**
   * Author slugs, in title order. [0] is the host — the directory the work
   * lives in and the primary author used for the artefact path and identity.
   * A co-authored work is registered under every slug here (see buildCatalog).
   */
  authorSlugs: string[];
  slug: string;
  title: string;
  breadcrumb: string;
  imported: boolean;
  published: number[];
  canonicalSlug: string; // slug of the canonical (default) edition
  /**
   * Whether the work appears as its own text in UI indexes. A work borrowed
   * into a collection (its editions spliced in as borrowed children) is also a
   * standalone directory, so it lists independently by default. Setting
   * `standalone = false` on the work's `index.mit` keeps it out of the indexes,
   * leaving it reachable only through the collection(s) that borrow it.
   */
  standalone: boolean;
  dir: string; // absolute directory owning this work's files
  editions: Edition[]; // dated editions, ascending by year
};

export type Catalog = {
  authors: Author[]; // ascending by year of first publication
  byAuthor: Map<string, Author>;
  /** Source file path for every separately-loaded document root. */
  sources: WeakMap<MarkitDocument, string>;
};

export type Section = {
  doc: MarkitDocument;
  slug: string;
  path: string[]; // slugs from the edition root down to this section
  title: string;
  breadcrumb: string;
  imported: boolean; // own value, or inherited from the nearest ancestor
  /** Author slugs of this section: its own `authors`, or the nearest ancestor's. */
  authors: string[];
  children: Section[];
};

const EDITION_RE = /^\d{4}[a-z]?$/;

export const lastSegment = (id: string): string => {
  const parts = id.split(/[./]/);
  return parts[parts.length - 1]!; // split always yields at least one part
};

const metaString = (doc: MarkitDocument, key: string): string | undefined => {
  const value = doc.metadata?.[key];
  return typeof value === "string" ? value : undefined;
};

const metaNumber = (doc: MarkitDocument, key: string): number | undefined => {
  const value = doc.metadata?.[key];
  return typeof value === "number" ? value : undefined;
};

const metaBoolean = (doc: MarkitDocument, key: string): boolean | undefined => {
  const value = doc.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
};

const metaArray = (doc: MarkitDocument, key: string): (string | number)[] => {
  const value = doc.metadata?.[key];
  if (Array.isArray(value)) return value as (string | number)[];
  if (typeof value === "string" || typeof value === "number") return [value];
  return [];
};

/**
 * The author slugs a text declares with the cascading `authors` key (lowercased),
 * or undefined when it sets none — so a caller can fall back to the inherited
 * value. A bare string is treated as a one-element list.
 */
const metaAuthors = (doc: MarkitDocument): string[] | undefined => {
  const value = doc.metadata?.authors;
  if (Array.isArray(value)) {
    return value.map((s) => String(s).toLowerCase());
  }
  if (typeof value === "string") return [value.toLowerCase()];
  return undefined;
};

/**
 * Normalise an absolute path textually, collapsing empty and "." segments.
 * Every path here is built from the corpus dir (which buildCatalog absolutises
 * via realPath) and id segments, so it never contains a ".." and is always
 * absolute.
 */
const normalizePath = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    out.push(part);
  }
  return "/" + out.join("/");
};

/**
 * Resolve a path case-insensitively against the real file system, so that
 * references like "../NHR/1757" work on case-sensitive systems too.
 * Returns the actual path if found, otherwise undefined.
 */
const findFile = async (
  fs: CorpusFs,
  path: string,
): Promise<string | undefined> => {
  try {
    // realPath canonicalises letter case, so that "../NHR/1757" and
    // "../nhr/1757" cache and attribute identically.
    if ((await fs.stat(path))?.isFile) return await fs.realPath(path);
  } catch {
    // fall through to the case-insensitive walk
  }
  const parts = normalizePath(path).split("/").filter((p) => p !== "");
  let current = ""; // paths here are always absolute (see normalizePath)
  for (const part of parts) {
    let matched: string | undefined;
    try {
      for (const entry of await fs.readDir(current === "" ? "/" : current)) {
        if (entry.name.toLowerCase() === part.toLowerCase()) {
          matched = entry.name;
          break;
        }
      }
    } catch {
      return undefined;
    }
    if (matched === undefined) return undefined;
    current = `${current}/${matched}`;
  }
  try {
    if ((await fs.stat(current))?.isFile) return await fs.realPath(current);
  } catch {
    return undefined;
  }
  return undefined;
};

type LoadContext = {
  fs: CorpusFs;
  cache: Map<string, MarkitDocument | null>;
  stack: Set<string>;
  sources: WeakMap<MarkitDocument, string>;
  warnings: string[];
  /** Absolute path of the corpus's `data/works`, where borrowed children live. */
  worksDir: string;
};

/**
 * Load and compile a Markit file, recursively resolving `children` metadata.
 * Returns null (and records a warning) if the file cannot be read.
 */
const loadDocument = async (
  path: string,
  ctx: LoadContext,
): Promise<MarkitDocument | null> => {
  const key = normalizePath(path);
  const cached = ctx.cache.get(key);
  if (cached !== undefined) return cached;
  if (ctx.stack.has(key)) {
    ctx.warnings.push(`circular child reference involving ${key}`);
    return null;
  }
  const text = await ctx.fs.readFile(key);
  if (text === null) {
    ctx.cache.set(key, null);
    return null;
  }
  ctx.stack.add(key);
  const [doc] = compile(text);
  ctx.sources.set(doc, key);
  await resolveChildren(doc, key, ctx);
  ctx.stack.delete(key);
  ctx.cache.set(key, doc);
  return doc;
};

/** A borrowed-child placeholder's id ends with the bracketed edition id. */
const BORROWED_RE = /<([^<>]+)>$/;

/**
 * The corpus file for an edition named by a borrowed-child id `Author.Work.
 * Edition`: `data/works/<author>/<work>/<edition>.mit`, or its directory form
 * `<edition>/index.mit`. Returns undefined when the id has too few segments to
 * name an edition, or no such file exists. Resolution is case-insensitive (the
 * ids are title-cased, the directories lower-cased), so the id's own case
 * needn't match disk.
 */
const editionFile = async (
  id: string,
  ctx: LoadContext,
): Promise<string | undefined> => {
  const parts = id.split(".");
  if (parts.length < 3) return undefined;
  const [author, work, ...rest] = parts;
  const base = `${ctx.worksDir}/${author}/${work}/${rest.join(".")}`;
  return (await findFile(ctx.fs, `${base}.mit`)) ??
    (await findFile(ctx.fs, `${base}/index.mit`));
};

/**
 * Splice borrowed children into doc.children. A section whose id is wrapped in
 * angle brackets — `## <Hume.EHU.1750>` compiles to an id ending in
 * `<Hume.EHU.1750>` — is a placeholder for another edition: it is replaced, in
 * place, by that edition's recursively-loaded document. Ordinary inline sections
 * are left untouched, so the two kinds keep their file order. Unresolvable
 * borrowed references are dropped with a warning.
 */
const resolveChildren = async (
  doc: MarkitDocument,
  path: string,
  ctx: LoadContext,
): Promise<void> => {
  const resolved: MarkitDocument[] = [];
  for (const child of doc.children) {
    const ref = BORROWED_RE.exec(child.id)?.[1];
    if (ref === undefined) {
      resolved.push(child); // an ordinary inline section
      continue;
    }
    const file = await editionFile(ref, ctx);
    const borrowed = file === undefined ? null : await loadDocument(file, ctx);
    if (borrowed !== null) {
      resolved.push(borrowed);
    } else {
      ctx.warnings.push(`unresolved child "${ref}" in ${path}`);
    }
  }
  doc.children = resolved;
};

const makeEdition = (
  workAuthorSlugs: string[],
  workSlug: string,
  slug: string,
  document: MarkitDocument,
): Edition => ({
  // An edition usually inherits the work's authors; it may name its own with
  // an `authors` key (e.g. a co-authored edition's root lists both).
  authorSlugs: metaAuthors(document) ?? workAuthorSlugs,
  workSlug,
  slug,
  title: metaString(document, "title") ?? document.id,
  breadcrumb: metaString(document, "breadcrumb") ??
    metaString(document, "title") ?? document.id,
  // Texts are assumed present unless the corpus says otherwise; only files
  // with broken metadata lack the key entirely.
  imported: metaBoolean(document, "imported") ?? true,
  published: metaArray(document, "published").map(Number).filter((n) =>
    !Number.isNaN(n)
  ),
  copytext: metaArray(document, "copytext").map(String),
  sourceUrl: metaString(document, "sourceUrl"),
  sourceDesc: metaString(document, "sourceDesc"),
  document,
});

/**
 * Load one work. Every work is a directory `<author>/<work>/` whose
 * `index.mit` is a metadata-only stub (work identity + a `canonical` pointer);
 * the texts live in year-named editions (`1757.mit` or `1758/index.mit`). The
 * stub and the retained, unexposed reading text (`main.mit`) are never
 * editions — only year slugs are.
 */
const loadWork = async (
  authorSlug: string,
  entry: Deno.DirEntry,
  authorDir: string,
  ctx: LoadContext,
): Promise<Work | undefined> => {
  if (!entry.isDirectory) return undefined;
  const dir = `${authorDir}/${entry.name}`;
  const indexPath = await findFile(ctx.fs, `${dir}/index.mit`);
  if (indexPath === undefined) return undefined; // not a work
  const slug = entry.name.toLowerCase();
  const stub = await loadDocument(indexPath, ctx);
  if (stub === null) return undefined;

  // The work's authors: the stub's `authors`, with the host (directory) author
  // first so authorSlugs[0] is always the primary used for the artefact path.
  // A work with no declared authors (test fixtures) is the directory author's.
  const declaredAuthors = metaAuthors(stub) ?? [];
  const authorSlugs = [
    authorSlug,
    ...declaredAuthors.filter((s) => s !== authorSlug),
  ];

  const editionSlugs: string[] = [];
  for (const sub of await ctx.fs.readDir(dir)) {
    const name = sub.isFile && sub.name.endsWith(".mit")
      ? sub.name.slice(0, -4)
      : sub.isDirectory
      ? sub.name
      : undefined;
    if (name !== undefined && EDITION_RE.test(name)) {
      editionSlugs.push(name);
    }
  }
  editionSlugs.sort();
  const editions: Edition[] = [];
  for (const editionSlug of editionSlugs) {
    const file = (await findFile(ctx.fs, `${dir}/${editionSlug}.mit`)) ??
      (await findFile(ctx.fs, `${dir}/${editionSlug}/index.mit`));
    const doc = file === undefined ? null : await loadDocument(file, ctx);
    if (doc !== null) {
      editions.push(makeEdition(authorSlugs, slug, editionSlug, doc));
    }
  }
  if (editions.length === 0) {
    ctx.warnings.push(`data/works/${authorSlug}/${slug}: no editions`);
    return undefined;
  }

  // Canonical edition: the stub's `canonical` key, else the latest edition.
  const declared = metaString(stub, "canonical")?.toLowerCase();
  const canonical = editions.find((e) => e.slug === declared) ??
    editions[editions.length - 1];
  if (declared !== undefined && canonical.slug !== declared) {
    ctx.warnings.push(
      `data/works/${authorSlug}/${slug}: canonical "${declared}" is not an edition`,
    );
  }

  const title = metaString(stub, "title") ?? stub.id;
  const published = metaArray(stub, "published").map(Number).filter((n) =>
    !Number.isNaN(n)
  );
  return {
    authorSlugs,
    slug,
    title,
    breadcrumb: metaString(stub, "breadcrumb") ?? title,
    imported: canonical.imported,
    published: published.length > 0 ? published : canonical.published,
    canonicalSlug: canonical.slug,
    // Works list independently unless the stub opts out (collection-only subworks).
    standalone: metaBoolean(stub, "standalone") ?? true,
    dir,
    editions,
  };
};

const makeAuthor = (slug: string, doc: MarkitDocument | null): Author => ({
  slug,
  forename: doc === null ? "" : metaString(doc, "forename") ?? "",
  surname: doc === null ? slug : metaString(doc, "surname") ?? slug,
  title: doc === null ? undefined : metaString(doc, "title"),
  birth: doc === null ? undefined : metaNumber(doc, "birth"),
  death: doc === null ? undefined : metaNumber(doc, "death"),
  published: doc === null ? undefined : metaNumber(doc, "published"),
  nationality: doc === null ? undefined : metaString(doc, "nationality"),
  sex: doc === null ? undefined : metaString(doc, "sex"),
  works: [],
});

export const buildCatalog = async (
  fs: CorpusFs,
  corpusDir: string,
): Promise<{ catalog: Catalog; warnings: string[] }> => {
  // Canonicalise so that work directories and child-reference paths agree.
  corpusDir = await fs.realPath(corpusDir);
  const dataDir = `${corpusDir}/data`;
  const ctx: LoadContext = {
    fs,
    cache: new Map(),
    stack: new Set(),
    sources: new WeakMap(),
    warnings: [],
    worksDir: `${dataDir}/works`,
  };
  const byAuthor = new Map<string, Author>();

  try {
    for (const entry of await fs.readDir(`${dataDir}/authors`)) {
      if (!entry.isFile || !entry.name.endsWith(".mit")) continue;
      const slug = entry.name.slice(0, -4).toLowerCase();
      const doc = await loadDocument(`${dataDir}/authors/${entry.name}`, ctx);
      byAuthor.set(slug, makeAuthor(slug, doc));
    }
  } catch {
    ctx.warnings.push(`no authors directory in ${dataDir}`);
  }

  // Load every work under its host directory, collecting them so co-authored
  // works can be registered under their other authors in a second pass.
  const loaded: Work[] = [];
  for (const entry of await fs.readDir(`${dataDir}/works`)) {
    if (!entry.isDirectory) continue;
    const authorSlug = entry.name.toLowerCase();
    let author = byAuthor.get(authorSlug);
    if (author === undefined) {
      ctx.warnings.push(
        `data/works/${entry.name} has no data/authors/${entry.name}.mit`,
      );
      author = makeAuthor(authorSlug, null);
      byAuthor.set(authorSlug, author);
    }
    const authorDir = `${dataDir}/works/${entry.name}`;
    for (const sub of await fs.readDir(authorDir)) {
      const work = await loadWork(authorSlug, sub, authorDir, ctx);
      if (work !== undefined) {
        author.works.push(work);
        loaded.push(work);
      }
    }
  }

  // A co-authored work lives once on disk (under its host author) but appears in
  // the catalog under every author it names, so both authors' pages list it. The
  // host (authorSlugs[0]) already holds it from the load above; add the rest.
  for (const work of loaded) {
    for (const slug of work.authorSlugs.slice(1)) {
      let coAuthor = byAuthor.get(slug);
      if (coAuthor === undefined) {
        ctx.warnings.push(
          `data/works/${work.authorSlugs[0]}/${work.slug} names co-author ` +
            `"${slug}" with no data/authors/${slug}.mit`,
        );
        coAuthor = makeAuthor(slug, null);
        byAuthor.set(slug, coAuthor);
      }
      if (!coAuthor.works.includes(work)) coAuthor.works.push(work);
    }
  }

  for (const author of byAuthor.values()) {
    author.works.sort((a, b) =>
      (a.published[0] ?? Infinity) - (b.published[0] ?? Infinity) ||
      a.slug.localeCompare(b.slug)
    );
  }

  const authors = [...byAuthor.values()].sort((a, b) =>
    (a.published ?? Infinity) - (b.published ?? Infinity) ||
    a.surname.localeCompare(b.surname)
  );

  return {
    catalog: { authors, byAuthor, sources: ctx.sources },
    warnings: ctx.warnings,
  };
};

/**
 * URL slug for a child section. Inline sections have ids nested under the
 * parent's id, so the last segment suffices ("Hume.THN.1.2" -> "2"). A child
 * pulled in from another work (composite editions) keeps its own id; use the
 * whole id with dots dashed ("Hume.EMPL1.1777" -> "hume-empl1-1777") to
 * avoid collisions between e.g. EMPL1.1777 and EMPL2.1777 inside ETSS.
 */
export const childSlug = (
  child: MarkitDocument,
  parent: MarkitDocument,
): string =>
  child.id.toLowerCase().startsWith(parent.id.toLowerCase() + ".")
    ? lastSegment(child.id).toLowerCase()
    : child.id.toLowerCase().replace(/\./g, "-");

/**
 * Build the section tree for an edition's document. `imported` and `authors`
 * both cascade: a section without its own value takes the nearest ancestor's.
 * `inheritedAuthors` seeds the root level with the edition's authors, so a
 * single-author work's sections inherit it even when the file omits `authors`.
 */
export const sectionTree = (
  doc: MarkitDocument,
  basePath: string[] = [],
  inheritedImported?: boolean,
  inheritedAuthors: string[] = [],
): Section[] => {
  const parentImported = metaBoolean(doc, "imported") ??
    inheritedImported ?? true;
  const parentAuthors = metaAuthors(doc) ?? inheritedAuthors;
  return doc.children.map((child) => {
    const slug = childSlug(child, doc);
    const path = [...basePath, slug];
    const authors = metaAuthors(child) ?? parentAuthors;
    return {
      doc: child,
      slug,
      path,
      title: metaString(child, "title") ?? lastSegment(child.id),
      breadcrumb: metaString(child, "breadcrumb") ??
        metaString(child, "title") ?? lastSegment(child.id),
      imported: metaBoolean(child, "imported") ?? parentImported,
      authors,
      children: sectionTree(child, path, parentImported, authors),
    };
  });
};
