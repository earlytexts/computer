/**
 * The extraction/tokenisation pipeline contract, and the block shaping the
 * computer adds on top of Markit's.
 *
 * Extraction and tokenisation are Markit's (`extractText`, `tokenize`,
 * `highlight`, `resolve` — one walk, so character offsets recorded against
 * extracted text at build time map back into the block structure at serve
 * time). This module pins the pipeline's version stamp — anything that changes
 * what markit's walk emits (including a markit upgrade, which must be reviewed
 * against its analysis-projection semantics) must bump these constants,
 * invalidating all built artefacts (see artefacts.ts) — and keeps the two
 * block-shaping helpers markit deliberately has no view on: the `both` display
 * case (the block untouched, editorial markup intact) and the synthesis of
 * whole-block insertions/deletions for cross-edition diffs.
 */

import { type Block, resolve } from "@earlytexts/markit";
import type {
  BlockElement,
  InlineElement,
  List,
  NestableBlockElement,
} from "@earlytexts/markit";
import type { Version } from "../../types.ts";

// 2: editorial insertions/deletions are resolved per version (was: both
// sides of every correction were extracted, matching neither version).
// 3: (was) a non-breaking space extracted to a `~` marker, so the tokenizer
// could rejoin the fixed multi-word unit it marked.
// 4: a non-breaking space extracted to a plain space; fixed multi-word units
// were fused from the register by the tokenizer's join pass.
// 5: extraction is markit's `extractText`: a non-breaking space extracts as
// U+00A0, so a `~`-fused unit (`a~priori`) reads as one token with no
// adjacency bookkeeping; a tab extracts as `\t`.
export const EXTRACTION_VERSION = 5;

// 2: query is matched as a phrase; postings carry a capitalisation bit.
// 3: (was) productive spelling-class folds around a stemmer, since retired.
// 4: two internal joiners of the computer's own regex — a period before a
// letter and the `~` a non-breaking space extracted to.
// 5: word identity imported from the corpus (`wordPattern`/`fold`); the
// register-driven multi-word join fused `a priori` after segmentation.
// 6: tokenisation is markit's `tokenize`: the word alphabet joins across the
// U+00A0 an `nbSpace` extracts to, so multi-word identity is the `~` in the
// source text — the register-driven join is gone.
export const TOKENIZER_VERSION = 6;

/** A [start, end) character range in a block's extracted text. */
export type HighlightRange = { start: number; end: number };

/**
 * A copy of the block resolved to the given version, with no highlights:
 * `edited`/`original` strip the editorial markup down to plain reading text
 * (markit's `resolve`), `both` returns the block unchanged (markup intact).
 * What `davidhume` and the companion render for display.
 */
export const resolveBlock = (block: Block, version: Version): Block =>
  version === "both" ? block : resolve(block, version);

/** Wrap a block's whole inline content in a single insertion or deletion. */
const wrapInline = (
  content: InlineElement[],
  kind: "insertion" | "deletion",
): InlineElement[] => (content.length === 0 ? [] : [{ type: kind, content }]);

const markList = (list: List, kind: "insertion" | "deletion"): List => ({
  ...list,
  items: list.items.map((item) => {
    const content = wrapInline(item.content, kind);
    if (item.nestedList === undefined) return { ...item, content };
    return { ...item, content, nestedList: markList(item.nestedList, kind) };
  }),
});

const markNestable = (
  element: NestableBlockElement,
  kind: "insertion" | "deletion",
): NestableBlockElement => {
  switch (element.type) {
    case "paragraph":
      return { ...element, content: wrapInline(element.content, kind) };
    case "blockquote":
    case "stageDirection":
      return {
        ...element,
        content: element.content.map((child) => markNestable(child, kind)),
      };
    case "list":
      return markList(element, kind);
    case "table":
      return {
        ...element,
        rows: element.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({
            ...cell,
            content: wrapInline(cell.content, kind),
          })),
        })),
      };
  }
};

const markElement = (
  element: BlockElement,
  kind: "insertion" | "deletion",
): BlockElement =>
  element.type === "heading"
    ? {
      ...element,
      content: element.content.map((line) => ({
        ...line,
        content: wrapInline(line.content, kind),
      })),
    }
    : markNestable(element, kind);

/**
 * A copy of the block with all of its inline content wrapped in a single
 * editorial insertion or deletion — how a whole block present in only one
 * edition is expressed in a synthesized diff (see diff.ts's diffToBlocks).
 */
export const markBlock = (
  block: Block,
  kind: "insertion" | "deletion",
): Block => ({
  ...block,
  content: block.content.map((element) => markElement(element, kind)),
});

/** Whether a block contains any editorial insertion or deletion. */
export const hasEditorial = (block: Block): boolean => {
  const inElements = (elements: InlineElement[]): boolean =>
    elements.some((el) =>
      el.type === "insertion" || el.type === "deletion" ||
      ("content" in el && Array.isArray(el.content) && inElements(el.content))
    );
  const inList = (list: List): boolean =>
    list.items.some((item) =>
      inElements(item.content) ||
      (item.nestedList !== undefined && inList(item.nestedList))
    );
  const inNestable = (element: NestableBlockElement): boolean => {
    switch (element.type) {
      case "paragraph":
        return inElements(element.content);
      case "blockquote":
      case "stageDirection":
        return element.content.some(inNestable);
      case "list":
        return inList(element);
      case "table":
        return element.rows.some((row) =>
          row.cells.some((cell) => inElements(cell.content))
        );
    }
  };
  return block.content.some((element) =>
    element.type === "heading"
      ? element.content.some((line) => inElements(line.content))
      : inNestable(element)
  );
};
