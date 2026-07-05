/**
 * Helpers for comparing two editions of a work: matching up their section
 * trees so that e.g. section "dt" of EMPL1 1741 pairs with "dt" of 1777, and a
 * borrowed work pairs with itself across collection printings. Section slugs are
 * edition-independent by construction — inline sections keep their position slug
 * and a borrowed work keeps its work slug (see `childSlug`) — so a section's slug
 * path is its cross-edition key directly, with no normalisation needed.
 */

import { diffTokens } from "./diff.ts";

/**
 * The shape both section representations share: the catalogue's `Section`
 * (build time) and the artefacts' `SkeletonSection` (serve time). These
 * helpers are written against it so either can be aligned and matched.
 */
export type SectionNode = {
  slug: string;
  path: string[];
  title: string;
  children: SectionNode[];
};

/** Find a section by its slug path (the same path identifies it in any edition). */
export const findSectionByKey = <T extends SectionNode>(
  sections: T[],
  path: string[],
): T | undefined => {
  let current = sections;
  let found: T | undefined;
  for (const slug of path) {
    found = current.find((s) => s.slug === slug);
    if (found === undefined) return undefined;
    current = found.children as T[];
  }
  return found;
};

export type AlignedSection = {
  key: string;
  title: string;
  a?: SectionNode;
  b?: SectionNode;
  children: AlignedSection[];
};

/**
 * Align two section trees, pairing sections with equal keys. The result
 * preserves reading order (an order-preserving diff of the key sequences).
 */
export const alignSections = (
  a: SectionNode[],
  b: SectionNode[],
): AlignedSection[] => {
  const keys = (sections: SectionNode[]) =>
    sections.map((s) => ({ text: s.slug, spaced: false }));
  const aligned: AlignedSection[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of diffTokens(keys(a), keys(b))) {
    for (const _token of op.tokens) {
      if (op.type === "equal") {
        const sa = a[ai++];
        const sb = b[bi++];
        aligned.push({
          key: sb.slug,
          title: sb.title,
          a: sa,
          b: sb,
          children: alignSections(sa.children, sb.children),
        });
      } else if (op.type === "delete") {
        const sa = a[ai++];
        aligned.push({
          key: sa.slug,
          title: sa.title,
          a: sa,
          children: alignSections(sa.children, []),
        });
      } else {
        const sb = b[bi++];
        aligned.push({
          key: sb.slug,
          title: sb.title,
          b: sb,
          children: alignSections([], sb.children),
        });
      }
    }
  }
  return aligned;
};
