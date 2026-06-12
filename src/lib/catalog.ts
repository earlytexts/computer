/**
 * The catalog scans the `data` directory, compiles every Markit file, and
 * organises the results into works and editions.
 *
 * Layout conventions in `data/`:
 *  - A top-level `<work>.mit` file is a single-edition work (e.g. `thn.mit`).
 *  - A top-level directory containing `index.mit` is a multi-edition work.
 *    Its `index.mit` is the work's main text; sibling entries whose names
 *    look like years (`1757.mit`, `1742a.mit`, or directories `1758/index.mit`)
 *    are dated editions.
 *  - A document's `children` metadata may reference sections by id (inline
 *    `##` sections of the same file) or by relative file path (without the
 *    `.mit` extension). File references are loaded recursively and spliced
 *    into the document's children, allowing composite editions (ETSS, FD,
 *    HE volumes) to share text with other works.
 */

import { compile, type MarkitDocument } from "@earlytexts/markit";

export type Edition = {
  workSlug: string;
  slug: string; // "main" for index.mit, otherwise e.g. "1757", "1742a"
  isMain: boolean;
  title: string;
  breadcrumb: string;
  published: number[];
  copytext: string[];
  sourceDesc?: string;
  document: MarkitDocument;
};

export type Work = {
  slug: string;
  title: string;
  breadcrumb: string;
  dir: string; // absolute directory owning this work's files
  editions: Edition[]; // main edition first, then dated editions ascending
};

export type Catalog = {
  works: Work[];
  bySlug: Map<string, Work>;
  /** Source file path for every separately-loaded document root. */
  sources: WeakMap<MarkitDocument, string>;
};

export type Section = {
  doc: MarkitDocument;
  slug: string;
  path: string[]; // slugs from the edition root down to this section
  title: string;
  breadcrumb: string;
  children: Section[];
};

const EDITION_RE = /^\d{4}[a-z]?$/;

/** Preferred homepage ordering; anything unknown sorts after, alphabetically. */
const WORK_ORDER = [
  "thn",
  "a",
  "lg",
  "empl1",
  "empl2",
  "ehu",
  "epm",
  "dp",
  "nhr",
  "fd",
  "etss",
  "he",
  "dnr",
  "mol",
];

export const lastSegment = (id: string): string => {
  const parts = id.split(/[./]/);
  return parts[parts.length - 1] ?? id;
};

const metaString = (doc: MarkitDocument, key: string): string | undefined => {
  const value = doc.metadata?.[key];
  return typeof value === "string" ? value : undefined;
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
const findFile = async (path: string): Promise<string | undefined> => {
  try {
    // realPath canonicalises letter case, so that "../NHR/1757" and
    // "../nhr/1757" cache and attribute identically.
    if ((await Deno.stat(path)).isFile) return await Deno.realPath(path);
  } catch {
    // fall through to the case-insensitive walk
  }
  const parts = normalizePath(path).split("/").filter((p) => p !== "");
  let current = path.startsWith("/") ? "" : ".";
  for (const part of parts) {
    let matched: string | undefined;
    try {
      for await (const entry of Deno.readDir(current === "" ? "/" : current)) {
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
    if ((await Deno.stat(current)).isFile) return await Deno.realPath(current);
  } catch {
    return undefined;
  }
  return undefined;
};

type LoadContext = {
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
  let text: string;
  try {
    text = await Deno.readTextFile(key);
  } catch {
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
    const file = (await findFile(normalizePath(`${dir}/${ref}.mit`))) ??
      (await findFile(normalizePath(`${dir}/${ref}/index.mit`)));
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
  workSlug: string,
  slug: string,
  document: MarkitDocument,
): Edition => ({
  workSlug,
  slug,
  isMain: slug === "main",
  title: metaString(document, "title") ?? document.id,
  breadcrumb: metaString(document, "breadcrumb") ??
    metaString(document, "title") ?? document.id,
  published: metaArray(document, "published").map(Number).filter((n) =>
    !Number.isNaN(n)
  ),
  copytext: metaArray(document, "copytext").map(String),
  sourceDesc: metaString(document, "sourceDesc"),
  document,
});

export const loadCatalog = async (
  dataDir: string,
): Promise<{ catalog: Catalog; warnings: string[] }> => {
  // Canonicalise so that work directories and child-reference paths agree.
  dataDir = await Deno.realPath(dataDir);
  const ctx: LoadContext = {
    cache: new Map(),
    stack: new Set(),
    sources: new WeakMap(),
    warnings: [],
  };
  const works: Work[] = [];

  for await (const entry of Deno.readDir(dataDir)) {
    if (entry.isFile && entry.name.endsWith(".mit")) {
      const slug = entry.name.slice(0, -4).toLowerCase();
      const doc = await loadDocument(`${dataDir}/${entry.name}`, ctx);
      if (doc === null) continue;
      const main = makeEdition(slug, "main", doc);
      works.push({
        slug,
        title: main.title,
        breadcrumb: main.breadcrumb,
        dir: dataDir,
        editions: [main],
      });
    } else if (entry.isDirectory) {
      const dir = `${dataDir}/${entry.name}`;
      const indexPath = await findFile(`${dir}/index.mit`);
      if (indexPath === undefined) continue; // not a work (e.g. empl1/withdrawn)
      const slug = entry.name.toLowerCase();
      const indexDoc = await loadDocument(indexPath, ctx);
      if (indexDoc === null) continue;
      const main = makeEdition(slug, "main", indexDoc);
      const editions: Edition[] = [main];
      const editionSlugs: string[] = [];
      for await (const sub of Deno.readDir(dir)) {
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
      for (const editionSlug of editionSlugs) {
        const file = (await findFile(`${dir}/${editionSlug}.mit`)) ??
          (await findFile(`${dir}/${editionSlug}/index.mit`));
        const doc = file === undefined ? null : await loadDocument(file, ctx);
        if (doc !== null) editions.push(makeEdition(slug, editionSlug, doc));
      }
      works.push({
        slug,
        title: main.title,
        breadcrumb: main.breadcrumb,
        dir,
        editions,
      });
    }
  }

  const rank = (slug: string): number => {
    const index = WORK_ORDER.indexOf(slug);
    return index === -1 ? WORK_ORDER.length : index;
  };
  works.sort((a, b) =>
    rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug)
  );

  return {
    catalog: {
      works,
      bySlug: new Map(works.map((w) => [w.slug, w])),
      sources: ctx.sources,
    },
    warnings: ctx.warnings,
  };
};

/**
 * URL slug for a child section. Inline sections have ids nested under the
 * parent's id, so the last segment suffices ("Hume.THN.1.2" -> "2"). A child
 * pulled in from another work (composite editions) keeps its own id; use the
 * whole id minus the "Hume." prefix ("Hume.EMPL1.1777" -> "empl1-1777") to
 * avoid collisions between e.g. EMPL1.1777 and EMPL2.1777 inside ETSS.
 */
export const childSlug = (
  child: MarkitDocument,
  parent: MarkitDocument,
): string =>
  child.id.toLowerCase().startsWith(parent.id.toLowerCase() + ".")
    ? lastSegment(child.id).toLowerCase()
    : child.id.toLowerCase().replace(/^hume\./, "").replace(/\./g, "-");

/** Build the section tree for an edition's document. */
export const sectionTree = (
  doc: MarkitDocument,
  basePath: string[] = [],
): Section[] =>
  doc.children.map((child) => {
    const slug = childSlug(child, doc);
    const path = [...basePath, slug];
    return {
      doc: child,
      slug,
      path,
      title: metaString(child, "title") ?? lastSegment(child.id),
      breadcrumb: metaString(child, "breadcrumb") ??
        metaString(child, "title") ?? lastSegment(child.id),
      children: sectionTree(child, path),
    };
  });

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

export const findEdition = (
  work: Work,
  editionSlug: string,
): Edition | undefined => work.editions.find((e) => e.slug === editionSlug);
