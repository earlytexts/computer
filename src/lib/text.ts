/**
 * Canonical plain-text extraction from compiled Markit structures, and
 * highlight injection into them.
 *
 * Extraction is an order-preserving fold over a block's element tree: every
 * character of the output is either a verbatim copy of one plainText node's
 * content or a constant contributed by a known element type (line breaks,
 * spacing, joiners between block elements). Page breaks contribute nothing
 * (they can fall mid-word) and footnote references are dropped.
 *
 * Editorial markup makes each block two texts in one. The `edited` version
 * keeps insertions and drops deletions (the curated reading text, matching
 * Markit's renderText); `original` keeps deletions and drops insertions (the
 * printed text, character for character); `both` keeps the markup intact (the
 * within-edition diff). The walk takes a version: `edited`/`original` unwrap
 * the surviving side to plain content, `both` leaves the wrappers in place.
 *
 * Both `blockText` (used by the build pipeline's tokenizer and by diffing)
 * and `highlightBlock` (used to mark search matches in full formatted
 * blocks) are driven by the SAME walk, so character offsets recorded against
 * extracted text at build time can be mapped back into the block structure
 * at serve time without storing any offset map. Anything that changes what
 * the walk emits must bump EXTRACTION_VERSION, which invalidates all built
 * artefacts (see artefacts.ts).
 */

import type {
  Block,
  BlockElement,
  InlineElement,
  List,
  MarkitDocument,
} from "@earlytexts/markit";
import type { Version } from "../types.ts";

// 2: editorial insertions/deletions are resolved per version (was: both
// sides of every correction were extracted, matching neither version).
export const EXTRACTION_VERSION = 2;

/** A [start, end) character range in a block's extracted text. */
export type HighlightRange = { start: number; end: number };

type WalkState = {
  /** Characters of extracted text contributed so far. */
  pos: number;
  /** Sorted, merged ranges to highlight; empty when only extracting. */
  ranges: HighlightRange[];
  /** Which version's text the walk emits and keeps (see module comment). */
  version: Version;
  emit?: (text: string) => void;
};

const contribute = (state: WalkState, text: string): void => {
  state.pos += text.length;
  if (state.emit !== undefined) state.emit(text);
};

/** Constant text contributed by inline elements without nested content. */
const leafText = (element: InlineElement): string => {
  switch (element.type) {
    case "lineBreak":
      return "\n";
    case "emSpace":
    case "nbSpace":
      return " ";
    case "illegible":
      return "[...]";
    default: // footnoteReference, pageBreak
      return "";
  }
};

/**
 * Split a plainText node's content (whose extracted text spans
 * [start, start + content.length)) into plain and highlighted pieces.
 */
const splitPlainText = (
  content: string,
  start: number,
  ranges: HighlightRange[],
): InlineElement[] => {
  const end = start + content.length;
  const out: InlineElement[] = [];
  let cursor = start;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= end) break;
    const from = Math.max(range.start, cursor);
    const to = Math.min(range.end, end);
    if (from > cursor) {
      out.push({
        type: "plainText",
        content: content.slice(cursor - start, from - start),
      });
    }
    out.push({
      type: "highlight",
      content: [{
        type: "plainText",
        content: content.slice(from - start, to - start),
      }],
    });
    cursor = to;
  }
  if (cursor < end) {
    out.push({ type: "plainText", content: content.slice(cursor - start) });
  }
  return out;
};

const walkInline = (
  elements: InlineElement[],
  state: WalkState,
): InlineElement[] =>
  elements.flatMap((element): InlineElement[] => {
    if (element.type === "plainText") {
      const start = state.pos;
      contribute(state, element.content);
      const marked = state.ranges.some((range) =>
        range.start < state.pos && range.end > start
      );
      return marked
        ? splitPlainText(element.content, start, state.ranges)
        : [element];
    }
    if (element.type === "insertion" || element.type === "deletion") {
      const dropped = element.type === "insertion"
        ? state.version === "original"
        : state.version === "edited";
      if (dropped) return []; // contribute nothing; the side is gone
      const content = walkInline(element.content, state);
      // edited/original unwrap the surviving side to plain reading text;
      // `both` keeps the wrapper so the markup (the diff) shows.
      return state.version === "both" ? [{ ...element, content }] : content;
    }
    if ("content" in element) {
      return [{ ...element, content: walkInline(element.content, state) }];
    }
    contribute(state, leafText(element));
    return [element];
  });

const walkList = (list: List, state: WalkState): List => ({
  ...list,
  items: list.items.map((item, i) => {
    if (i > 0) contribute(state, "\n");
    const content = walkInline(item.content, state);
    if (item.nestedList === undefined) return { ...item, content };
    contribute(state, "\n");
    return { ...item, content, nestedList: walkList(item.nestedList, state) };
  }),
});

const walkElement = (
  element: BlockElement,
  state: WalkState,
): BlockElement => {
  switch (element.type) {
    case "heading":
      return {
        ...element,
        content: element.content.map((line, i) => {
          if (i > 0) contribute(state, "\n");
          return { ...line, content: walkInline(line.content, state) };
        }),
      };
    case "paragraph":
      return { ...element, content: walkInline(element.content, state) };
    case "blockquote":
      return {
        ...element,
        content: element.content.map((paragraph, i) => {
          if (i > 0) contribute(state, "\n");
          return {
            ...paragraph,
            content: walkInline(paragraph.content, state),
          };
        }),
      };
    case "list":
      return walkList(element, state);
    case "table":
      return {
        ...element,
        rows: element.rows.map((row, i) => {
          if (i > 0) contribute(state, "\n");
          return {
            ...row,
            cells: row.cells.map((cell, j) => {
              if (j > 0) contribute(state, " | ");
              return { ...cell, content: walkInline(cell.content, state) };
            }),
          };
        }),
      };
  }
};

const walkBlock = (block: Block, state: WalkState): Block => ({
  ...block,
  content: block.content.map((element, i) => {
    if (i > 0) contribute(state, "\n");
    return walkElement(element, state);
  }),
});

/** The extracted plain text of a block, in the given version (default edited). */
export const blockText = (
  block: Block,
  version: Version = "edited",
): string => {
  let text = "";
  walkBlock(block, { pos: 0, ranges: [], version, emit: (t) => text += t });
  return text;
};

/** Sorted, merged, non-empty copy of the given ranges. */
const mergeRanges = (ranges: HighlightRange[]): HighlightRange[] => {
  const sorted = ranges.filter((range) => range.end > range.start)
    .toSorted((a, b) => a.start - b.start);
  const out: HighlightRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else out.push({ ...range });
  }
  return out;
};

/**
 * A copy of the block resolved to the given version (default edited), with
 * the given ranges of its extracted text wrapped in Markit `highlight`
 * elements (rendered as <mark> by renderHTML). The ranges must be measured
 * against `blockText(block, version)`: the walk emits the same version, so
 * offsets line up. Only plainText nodes are ever split; characters
 * contributed by other elements are passed over, so a range spanning a line
 * break or page break simply resumes marking after it.
 */
export const highlightBlock = (
  block: Block,
  ranges: HighlightRange[],
  version: Version = "edited",
): Block => walkBlock(block, { pos: 0, ranges: mergeRanges(ranges), version });

/**
 * A copy of the block resolved to the given version, with no highlights:
 * `edited`/`original` strip the editorial markup down to plain reading text,
 * `both` returns the block unchanged (markup intact). What `davidhume` and
 * the companion render for display.
 */
export const resolveBlock = (block: Block, version: Version): Block =>
  version === "both"
    ? block
    : walkBlock(block, { pos: 0, ranges: [], version });

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

const markElement = (
  element: BlockElement,
  kind: "insertion" | "deletion",
): BlockElement => {
  switch (element.type) {
    case "heading":
      return {
        ...element,
        content: element.content.map((line) => ({
          ...line,
          content: wrapInline(line.content, kind),
        })),
      };
    case "paragraph":
      return { ...element, content: wrapInline(element.content, kind) };
    case "blockquote":
      return {
        ...element,
        content: element.content.map((paragraph) => ({
          ...paragraph,
          content: wrapInline(paragraph.content, kind),
        })),
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
  return block.content.some((element) => {
    switch (element.type) {
      case "heading":
        return element.content.some((line) => inElements(line.content));
      case "paragraph":
        return inElements(element.content);
      case "blockquote":
        return element.content.some((p) => inElements(p.content));
      case "list":
        return inList(element);
      case "table":
        return element.rows.some((row) =>
          row.cells.some((cell) => inElements(cell.content))
        );
    }
  });
};
