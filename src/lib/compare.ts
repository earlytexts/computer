/**
 * Helpers for comparing two editions of a work: matching up their section
 * trees so that e.g. section "dt" of EMPL1 1741 pairs with "dt" of 1777,
 * and (in composite editions) "empl1-1758" pairs with "empl1-1777".
 */

import type { Section } from "./catalog.ts";
import { diffTokens } from "./diff.ts";

/** Key used to match sections across editions of the same work. */
export const sectionKey = (slug: string): string =>
  slug.replace(/-\d{4}[a-z]?$/, "");

export const pathKey = (path: string[]): string[] => path.map(sectionKey);

/** Find a section by a key path (edition-independent path). */
export const findSectionByKey = (
  sections: Section[],
  keyPath: string[],
): Section | undefined => {
  let current = sections;
  let found: Section | undefined;
  for (const key of keyPath) {
    found = current.find((s) => sectionKey(s.slug) === key);
    if (found === undefined) return undefined;
    current = found.children;
  }
  return found;
};

export type AlignedSection = {
  key: string;
  title: string;
  a?: Section;
  b?: Section;
  children: AlignedSection[];
};

/**
 * Align two section trees, pairing sections with equal keys. The result
 * preserves reading order (an order-preserving diff of the key sequences).
 */
export const alignSections = (
  a: Section[],
  b: Section[],
): AlignedSection[] => {
  const keys = (sections: Section[]) =>
    sections.map((s) => ({ text: sectionKey(s.slug), spaced: false }));
  const aligned: AlignedSection[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of diffTokens(keys(a), keys(b))) {
    for (const _token of op.tokens) {
      if (op.type === "equal") {
        const sa = a[ai++];
        const sb = b[bi++];
        aligned.push({
          key: sectionKey(sb.slug),
          title: sb.title,
          a: sa,
          b: sb,
          children: alignSections(sa.children, sb.children),
        });
      } else if (op.type === "delete") {
        const sa = a[ai++];
        aligned.push({
          key: sectionKey(sa.slug),
          title: sa.title,
          a: sa,
          children: alignSections(sa.children, []),
        });
      } else {
        const sb = b[bi++];
        aligned.push({
          key: sectionKey(sb.slug),
          title: sb.title,
          b: sb,
          children: alignSections([], sb.children),
        });
      }
    }
  }
  return aligned;
};
