/**
 * The catalogue is built by the corpus, not the computer. The corpus's build task
 * scans, compiles, and composes the corpus into `catalogue/` (catalogue.json plus one
 * document per edition); the corpus package also owns the wire format and the
 * loader that reads it back (`loadCatalogue`, re-exported here with its types), so
 * serialize and deserialize live together in one place. The computer consumes
 * only the compiled `catalogue/` data — plus this contract code.
 *
 * The section-tree projection (`sectionTree`, `childSlug`, `lastSegment`) lives
 * here because it is a build-time concern over already-loaded documents, used by
 * builder.ts and (lastSegment) diff.ts — not part of scanning the corpus.
 */

import type { MarkitDocument } from "@earlytexts/markit";

export {
  type Author,
  type Catalogue,
  type CatalogueAuthor,
  type CatalogueEdition,
  type CatalogueFile,
  type CatalogueReader,
  type CatalogueWork,
  type DocRefNode,
  type Edition,
  loadCatalogue,
  type SerializedDoc as RawDoc,
  type Work,
} from "@earlytexts/corpus/wire";

/* -------------------------- section tree type ------------------------ */

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
