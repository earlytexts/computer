/**
 * The catalog is built by the corpus, not the computer. The corpus's build task
 * scans, compiles, and composes the corpus into `dist/` (catalogue.json plus one
 * document per edition); this module loads that compiled output back into the
 * in-memory `Catalog` the builder consumes — parsing the documents and splicing
 * borrowed children by reference, so the shared object graph the build relies on
 * (one instance per edition document, shared blocks) is recreated faithfully.
 *
 * The section-tree projection (`sectionTree`, `childSlug`, `lastSegment`) lives
 * here because it is a build-time concern over already-loaded documents, used by
 * builder.ts and (lastSegment) diff.ts — not part of scanning the corpus.
 */

import type { Block, MarkitDocument } from "@earlytexts/markit";

/* ------------------------------ catalog ------------------------------ */

export type Author = {
  slug: string;
  forename: string;
  surname: string;
  title?: string; // honorific, e.g. "Lord Kames"
  birth?: number;
  death?: number;
  /** Earliest `firstPublished` across the author's works (derived by the
   * corpus); undefined if they have none. Used for ordering. */
  firstPublished?: number;
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
  sourceUrl?: string;
  sourceDesc?: string;
  document: MarkitDocument;
};

export type Work = {
  /**
   * Author slugs, in title order — the people who wrote it. The work is
   * registered under every slug here. For its identity/path, see `hostSlug`.
   */
  authorSlugs: string[];
  /**
   * Identity slug: the directory the work lives in, used for its artefact path
   * and URL. A single author's slug, or a joint slug ("astell-norris") for a
   * co-authored work — which is not itself an author.
   */
  hostSlug: string;
  slug: string;
  title: string;
  breadcrumb: string;
  imported: boolean;
  /** Earliest publication year across all editions (derived by the corpus). */
  firstPublished: number;
  canonicalSlug: string; // slug of the canonical (default) edition
  /**
   * Whether the work appears as its own text in UI indexes. A work borrowed
   * into a collection lists independently by default; `standalone = false` keeps
   * it out of the indexes, reachable only through the collection(s) that borrow it.
   */
  standalone: boolean;
  dir: string; // directory owning this work's files (relative to the corpus root)
  editions: Edition[]; // dated editions, ascending by year
};

export type Catalog = {
  authors: Author[]; // ascending by year of first publication
  byAuthor: Map<string, Author>;
  /** Source file path (relative to the corpus root) for every loaded edition. */
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

/* --------------------- compiled catalogue (wire) --------------------- */

/**
 * The shape of the corpus's compiled output (corpus/src/serialize.ts). These
 * mirror the corpus's serialised contract — the consumer's copy of the wire
 * format. The corpus is the authoritative source of the schema; the computer
 * only reads.
 */
export type DocRefNode = { __ref: string };

/** A serialised document: a Markit document whose borrowed kids are refs. */
export type RawDoc = {
  id: string;
  metadata?: MarkitDocument["metadata"];
  blocks: Block[];
  children: (RawDoc | DocRefNode)[];
};

export type CatalogueEdition = {
  authorSlugs: string[];
  workSlug: string;
  slug: string;
  title: string;
  breadcrumb: string;
  imported: boolean;
  published: number[];
  sourceUrl?: string;
  sourceDesc?: string;
  docKey: string;
  source: string;
};

export type CatalogueWork = {
  authorSlugs: string[];
  hostSlug: string;
  slug: string;
  title: string;
  breadcrumb: string;
  imported: boolean;
  firstPublished: number;
  canonicalSlug: string;
  standalone: boolean;
  dir: string;
  editions: CatalogueEdition[];
};

export type CatalogueAuthor = {
  slug: string;
  forename: string;
  surname: string;
  title?: string;
  birth?: number;
  death?: number;
  firstPublished?: number;
  nationality?: string;
  sex?: string;
  works: string[];
};

export type CatalogueFile = {
  authors: CatalogueAuthor[];
  works: Record<string, CatalogueWork>;
  warnings: string[];
};

/**
 * The reader the load needs: the compiled catalogue, and each edition's document
 * by key. The io adapter supplies the Deno-backed implementation; tests an
 * in-memory one. Both return null when absent (a corpus that was never built).
 */
export interface CatalogueReader {
  readCatalogue(corpusDir: string): Promise<CatalogueFile | null>;
  readDocument(corpusDir: string, docKey: string): Promise<RawDoc | null>;
}

/* ------------------------------ loading ------------------------------ */

const isRef = (node: RawDoc | DocRefNode): node is DocRefNode =>
  "__ref" in node;

/**
 * Load the compiled catalogue into the in-memory `Catalog`. Reads every
 * edition's document, then composes each lazily — splicing a borrowed child as
 * the single shared instance of the edition it names, so a text borrowed into
 * several collections is one object (the build dedupes its blocks by identity).
 */
export const loadCatalog = async (
  reader: CatalogueReader,
  corpusDir: string,
): Promise<{ catalog: Catalog; warnings: string[] }> => {
  const file = await reader.readCatalogue(corpusDir);
  if (file === null) {
    throw new Error(
      `no compiled catalogue at ${corpusDir}/dist; run the corpus build`,
    );
  }

  // Read every edition's raw (uncomposed) document up front, keyed by docKey.
  // The corpus build writes one document per edition, so each read hits.
  const raw = new Map<string, RawDoc>();
  for (const work of Object.values(file.works)) {
    for (const edition of work.editions) {
      raw.set(
        edition.docKey,
        (await reader.readDocument(
          corpusDir,
          edition.docKey,
        ))!,
      );
    }
  }

  // Compose a document by reference: each `{ __ref }` child becomes the shared
  // composed instance of that edition. Memoised, so every borrow of an edition
  // resolves to one object (no cycles — the corpus drops them at build time).
  const composed = new Map<string, MarkitDocument>();
  const build = (node: RawDoc): MarkitDocument =>
    ({
      id: node.id,
      ...(node.metadata !== undefined ? { metadata: node.metadata } : {}),
      blocks: node.blocks,
      children: node.children.map((child) =>
        isRef(child) ? compose(child.__ref) : build(child)
      ),
    }) as MarkitDocument;
  const compose = (docKey: string): MarkitDocument => {
    const cached = composed.get(docKey);
    if (cached !== undefined) return cached;
    const doc = build(raw.get(docKey)!);
    composed.set(docKey, doc);
    return doc;
  };

  const sources = new WeakMap<MarkitDocument, string>();
  const byAuthor = new Map<string, Author>();

  // Rebuild each work once (shared across the authors that list it), then point
  // every author at its works by key — recreating the co-authored sharing.
  const works = new Map<string, Work>();
  for (const [key, w] of Object.entries(file.works)) {
    const editions = w.editions.map((e): Edition => {
      const document = compose(e.docKey);
      sources.set(document, e.source);
      return {
        authorSlugs: e.authorSlugs,
        workSlug: e.workSlug,
        slug: e.slug,
        title: e.title,
        breadcrumb: e.breadcrumb,
        imported: e.imported,
        published: e.published,
        sourceUrl: e.sourceUrl,
        sourceDesc: e.sourceDesc,
        document,
      };
    });
    works.set(key, {
      authorSlugs: w.authorSlugs,
      hostSlug: w.hostSlug,
      slug: w.slug,
      title: w.title,
      breadcrumb: w.breadcrumb,
      imported: w.imported,
      firstPublished: w.firstPublished,
      canonicalSlug: w.canonicalSlug,
      standalone: w.standalone,
      dir: w.dir,
      editions,
    });
  }

  const authors = file.authors.map((a): Author => {
    const author: Author = {
      slug: a.slug,
      forename: a.forename,
      surname: a.surname,
      title: a.title,
      birth: a.birth,
      death: a.death,
      firstPublished: a.firstPublished,
      nationality: a.nationality,
      sex: a.sex,
      works: a.works.map((key) => works.get(key)!),
    };
    byAuthor.set(a.slug, author);
    return author;
  });

  return { catalog: { authors, byAuthor, sources }, warnings: file.warnings };
};

/* -------------------- section-tree projection ------------------------ */

export const lastSegment = (id: string): string => {
  const parts = id.split(/[./]/);
  return parts[parts.length - 1]!; // split always yields at least one part
};

/**
 * The work slug of an edition id: the segment before the year
 * ("Hume.EMPL1.1777" -> "empl1"). Used to slug a borrowed edition by its work.
 */
const workSegment = (id: string): string => {
  const parts = id.split(".");
  return parts[parts.length - 2]!.toLowerCase(); // a borrowed id is Author.Work.Year
};

const metaString = (doc: MarkitDocument, key: string): string | undefined => {
  const value = doc.metadata?.[key];
  return typeof value === "string" ? value : undefined;
};

const metaBoolean = (doc: MarkitDocument, key: string): boolean | undefined => {
  const value = doc.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
};

const metaAuthors = (doc: MarkitDocument): string[] | undefined => {
  const value = doc.metadata?.authors;
  if (Array.isArray(value)) return value.map((s) => String(s).toLowerCase());
  if (typeof value === "string") return [value.toLowerCase()];
  return undefined;
};

/**
 * URL slug for a child section. Inline sections have ids nested under the
 * parent's id, so the last segment suffices ("Hume.THN.1.2" -> "2"). A child
 * borrowed from another work (composite editions) keeps its own edition id
 * ("Hume.EMPL1.1777"); slug it by that work's slug — the id segment before the
 * year ("empl1") — so the path reads cleanly ("etss/1777/empl1/dt/...") and the
 * borrowed work keeps one slug across every collection and printing that borrows
 * it (so cross-edition section matching needs no year stripping). Work slugs are
 * distinct and never year-shaped, so they collide neither with sibling borrows
 * nor with the edition/section disambiguation the routes rely on.
 */
export const childSlug = (
  child: MarkitDocument,
  parent: MarkitDocument,
): string =>
  child.id.toLowerCase().startsWith(parent.id.toLowerCase() + ".")
    ? lastSegment(child.id).toLowerCase()
    : workSegment(child.id);

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
