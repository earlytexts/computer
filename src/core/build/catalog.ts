/**
 * The catalog scans the corpus, compiles every Markit file, and organises the
 * results into authors, works, and editions.
 *
 * Corpus layout (see corpus/README.md):
 *  - `authors/<author>.mit` holds an author's metadata (no text).
 *  - `works/<author>/<work>/` is a work. Its `index.mit` is a metadata-only
 *    stub: the work's edition-independent identity (title, breadcrumb,
 *    published) plus a `canonical` key naming the default edition. The texts
 *    are year-named editions — sibling entries whose names look like years
 *    (`1757.mit`, `1742a.mit`, or directories `1758/index.mit`). A `main.mit`
 *    sibling (the retained old reading text) is kept but never exposed.
 *  - A document's `children` metadata may reference sections by id (inline
 *    `##` sections of the same file) or by relative file path (without the
 *    `.mit` extension). File references are loaded recursively and spliced
 *    into the document's children, allowing composite works (collections
 *    like ETSS, FD, HE) to share text with other works.
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
  authorSlug: string;
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
  authorSlug: string;
  slug: string;
  title: string;
  breadcrumb: string;
  imported: boolean;
  published: number[];
  canonicalSlug: string; // slug of the canonical (default) edition
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
  children: Section[];
};

const EDITION_RE = /^\d{4}[a-z]?$/;

export const lastSegment = (id: string): string => {
  const parts = id.split(/[./]/);
  return parts[parts.length - 1] ?? id;
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

/** Normalise a path textually, resolving "." and "..". */
const normalizePath = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + out.join("/");
};

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

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
  let current = path.startsWith("/") ? "" : ".";
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

/**
 * Replace doc.children according to the `children` metadata, if present.
 * Each reference is either the id of an inline section or a relative file
 * path; unresolvable references are skipped with a warning. Inline sections
 * not mentioned in the metadata are appended in their original order.
 */
const resolveChildren = async (
  doc: MarkitDocument,
  path: string,
  ctx: LoadContext,
): Promise<void> => {
  const refs = metaArray(doc, "children").map(String);
  if (refs.length === 0) return;
  const inline = new Map(
    doc.children.map((c) => [lastSegment(c.id).toLowerCase(), c]),
  );
  const used = new Set<string>();
  const resolved: MarkitDocument[] = [];
  const dir = dirOf(normalizePath(path));
  for (const ref of refs) {
    const refKey = lastSegment(ref).toLowerCase();
    const inlineMatch = !ref.includes("/") && !used.has(refKey)
      ? inline.get(refKey)
      : undefined;
    if (inlineMatch !== undefined) {
      used.add(refKey);
      resolved.push(inlineMatch);
      continue;
    }
    const file = (await findFile(ctx.fs, normalizePath(`${dir}/${ref}.mit`))) ??
      (await findFile(ctx.fs, normalizePath(`${dir}/${ref}/index.mit`)));
    const child = file === undefined ? null : await loadDocument(file, ctx);
    if (child !== null) {
      resolved.push(child);
    } else {
      ctx.warnings.push(`unresolved child "${ref}" in ${path}`);
    }
  }
  for (const child of doc.children) {
    if (!used.has(lastSegment(child.id).toLowerCase())) resolved.push(child);
  }
  doc.children = resolved;
};

const makeEdition = (
  authorSlug: string,
  workSlug: string,
  slug: string,
  document: MarkitDocument,
): Edition => ({
  authorSlug,
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
      editions.push(makeEdition(authorSlug, slug, editionSlug, doc));
    }
  }
  if (editions.length === 0) {
    ctx.warnings.push(`works/${authorSlug}/${slug}: no editions`);
    return undefined;
  }

  // Canonical edition: the stub's `canonical` key, else the latest edition.
  const declared = metaString(stub, "canonical")?.toLowerCase();
  const canonical = editions.find((e) => e.slug === declared) ??
    editions[editions.length - 1];
  if (declared !== undefined && canonical.slug !== declared) {
    ctx.warnings.push(
      `works/${authorSlug}/${slug}: canonical "${declared}" is not an edition`,
    );
  }

  const title = metaString(stub, "title") ?? stub.id;
  const published = metaArray(stub, "published").map(Number).filter((n) =>
    !Number.isNaN(n)
  );
  return {
    authorSlug,
    slug,
    title,
    breadcrumb: metaString(stub, "breadcrumb") ?? title,
    imported: canonical.imported,
    published: published.length > 0 ? published : canonical.published,
    canonicalSlug: canonical.slug,
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
  const ctx: LoadContext = {
    fs,
    cache: new Map(),
    stack: new Set(),
    sources: new WeakMap(),
    warnings: [],
  };
  const byAuthor = new Map<string, Author>();

  try {
    for (const entry of await fs.readDir(`${corpusDir}/authors`)) {
      if (!entry.isFile || !entry.name.endsWith(".mit")) continue;
      const slug = entry.name.slice(0, -4).toLowerCase();
      const doc = await loadDocument(`${corpusDir}/authors/${entry.name}`, ctx);
      byAuthor.set(slug, makeAuthor(slug, doc));
    }
  } catch {
    ctx.warnings.push(`no authors directory in ${corpusDir}`);
  }

  for (const entry of await fs.readDir(`${corpusDir}/works`)) {
    if (!entry.isDirectory) continue;
    const authorSlug = entry.name.toLowerCase();
    let author = byAuthor.get(authorSlug);
    if (author === undefined) {
      ctx.warnings.push(`works/${entry.name} has no authors/${entry.name}.mit`);
      author = makeAuthor(authorSlug, null);
      byAuthor.set(authorSlug, author);
    }
    const authorDir = `${corpusDir}/works/${entry.name}`;
    for (const sub of await fs.readDir(authorDir)) {
      const work = await loadWork(authorSlug, sub, authorDir, ctx);
      if (work !== undefined) author.works.push(work);
    }
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

/** Build the section tree for an edition's document. */
export const sectionTree = (
  doc: MarkitDocument,
  basePath: string[] = [],
  inheritedImported?: boolean,
): Section[] => {
  const parentImported = metaBoolean(doc, "imported") ??
    inheritedImported ?? true;
  return doc.children.map((child) => {
    const slug = childSlug(child, doc);
    const path = [...basePath, slug];
    return {
      doc: child,
      slug,
      path,
      title: metaString(child, "title") ?? lastSegment(child.id),
      breadcrumb: metaString(child, "breadcrumb") ??
        metaString(child, "title") ?? lastSegment(child.id),
      imported: metaBoolean(child, "imported") ?? parentImported,
      children: sectionTree(child, path, parentImported),
    };
  });
};

/** Depth-first flattening of a section tree (for prev/next navigation). */
export const flattenSections = (sections: Section[]): Section[] =>
  sections.flatMap((s) => [s, ...flattenSections(s.children)]);

/** Find a section by its slug path. */
export const findSection = (
  doc: MarkitDocument,
  path: string[],
): Section | undefined => {
  let sections = sectionTree(doc);
  let found: Section | undefined;
  for (const slug of path) {
    found = sections.find((s) => s.slug === slug.toLowerCase());
    if (found === undefined) return undefined;
    sections = found.children;
  }
  return found;
};

export const findWork = (
  catalog: Catalog,
  authorSlug: string,
  workSlug: string,
): Work | undefined =>
  catalog.byAuthor.get(authorSlug)?.works.find((w) => w.slug === workSlug);
