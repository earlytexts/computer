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

export const EXTRACTION_VERSION = 1;

/** A [start, end) character range in a block's extracted text. */
export type HighlightRange = { start: number; end: number };

type WalkState = {
  /** Characters of extracted text contributed so far. */
  pos: number;
  /** Sorted, merged ranges to highlight; empty when only extracting. */
  ranges: HighlightRange[];
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

/** The extracted plain text of a block. */
export const blockText = (block: Block): string => {
  let text = "";
  walkBlock(block, { pos: 0, ranges: [], emit: (t) => text += t });
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
 * A copy of the block with the given ranges of its extracted text wrapped
 * in Markit `highlight` elements (rendered as <mark> by renderHTML). Only
 * plainText nodes are ever split; characters contributed by other elements
 * are passed over, so a range spanning a line break or page break simply
 * resumes marking after it.
 */
export const highlightBlock = (
  block: Block,
  ranges: HighlightRange[],
): Block => walkBlock(block, { pos: 0, ranges: mergeRanges(ranges) });

/** Full text of a document, including all (inline) children, recursively. */
export const documentText = (doc: MarkitDocument): string =>
  [
    ...doc.blocks.map(blockText),
    ...doc.children.map(documentText),
  ].join("\n\n");
