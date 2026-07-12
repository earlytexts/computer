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
 * within-edition diff). The walk itself only ever runs for `edited`/`original`,
 * unwrapping the surviving side to plain content; `both` is served by returning
 * the block untouched (resolveBlock), so the walk never sees it.
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
  NestableBlockElement,
  Word as WordElement,
} from "@earlytexts/markit";
import { type Exemption, exemptions } from "@earlytexts/corpus/wire";
import type { Version } from "../../types.ts";

// 2: editorial insertions/deletions are resolved per version (was: both
// sides of every correction were extracted, matching neither version).
// 3: (was) a non-breaking space extracted to a `~` marker, so the tokenizer
// could rejoin the fixed multi-word unit it marked.
// 4: a non-breaking space extracts to a plain space, like an em-space — it no
// longer carries a join. A fixed multi-word unit (`a priori`) is fused from the
// register by tokenize.ts's `joinTokens`, over the adjacency the space leaves,
// so the marker (and its escaping wrinkle) is gone.
export const EXTRACTION_VERSION = 4;

/** A [start, end) character range in a block's extracted text. */
export type HighlightRange = { start: number; end: number };

/**
 * One run of plain extracted text (one plainText node), with the dictionary
 * context the same walk saw around it: the nearest enclosing exempting markup
 * (person / place / org / citation / language) and the value of the enclosing
 * `[w:surface=value]` element, if any. `tokenContexts` collects these so the
 * build can look up, by character offset, the reading context of every token it
 * finds in the extracted text — offsets and context therefore come from the one
 * extraction walk, so they cannot drift.
 */
export type ContextSpan = {
  start: number;
  end: number;
  exemption?: Exemption;
  wordValue?: string;
};

type WalkState = {
  /** Characters of extracted text contributed so far. */
  pos: number;
  /** Sorted, merged ranges to highlight; empty when only extracting. */
  ranges: HighlightRange[];
  /** Which version's text the walk emits and keeps (see module comment). */
  version: Version;
  emit?: (text: string) => void;
  /** When set, each plainText run is appended here with its enclosing context. */
  spans?: ContextSpan[];
  /** The nearest enclosing exempting markup during the walk. */
  exemption?: Exemption;
  /** The value of the nearest enclosing `[w:…]` element during the walk. */
  wordValue?: string;
};

const exemptionOf = (type: string): Exemption | undefined =>
  (exemptions as readonly string[]).includes(type)
    ? (type as Exemption)
    : undefined;

const contribute = (state: WalkState, text: string): void => {
  state.pos += text.length;
  if (state.emit !== undefined) state.emit(text);
};

/** Constant text contributed by inline elements without nested content. */
const leafText = (element: InlineElement): string => {
  switch (element.type) {
    case "lineBreak":
      return "\n";
    case "nbSpace":
    case "emSpace":
      // Ordinary space: a non-breaking space no longer carries a join — a fixed
      // multi-word unit is fused from the register (tokenize.ts's joinTokens).
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
      if (state.spans !== undefined && element.content.length > 0) {
        state.spans.push({
          start,
          end: state.pos,
          ...(state.exemption !== undefined
            ? { exemption: state.exemption }
            : {}),
          ...(state.wordValue !== undefined
            ? { wordValue: state.wordValue }
            : {}),
        });
      }
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
      // The walk only ever runs for edited/original (resolveBlock short-circuits
      // `both`), so the surviving side is always unwrapped to plain reading text.
      return walkInline(element.content, state);
    }
    if ("content" in element) {
      // Track the dictionary context (exemption / `[w:]` value) around the
      // recursion, restoring it after so siblings are unaffected. Only matters
      // when collecting spans; otherwise these stay undefined and unused.
      const exemption = exemptionOf(element.type);
      const previousExemption = state.exemption;
      const previousWord = state.wordValue;
      if (exemption !== undefined) state.exemption = exemption;
      if (element.type === "word") {
        state.wordValue = (element as WordElement).word;
      }
      const content = walkInline(element.content, state);
      state.exemption = previousExemption;
      state.wordValue = previousWord;
      return [{ ...element, content }];
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

const walkNestable = (
  element: NestableBlockElement,
  state: WalkState,
): NestableBlockElement => {
  switch (element.type) {
    case "paragraph":
      return { ...element, content: walkInline(element.content, state) };
    case "blockquote":
    case "stageDirection":
      return {
        ...element,
        content: element.content.map((child, i) => {
          if (i > 0) contribute(state, "\n");
          return walkNestable(child, state);
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

const walkElement = (
  element: BlockElement,
  state: WalkState,
): BlockElement =>
  element.type === "heading"
    ? {
      ...element,
      content: element.content.map((line, i) => {
        if (i > 0) contribute(state, "\n");
        return { ...line, content: walkInline(line.content, state) };
      }),
    }
    : walkNestable(element, state);

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

/**
 * The plain-text runs of a block, in order, each tagged with the exemption and
 * `[w:]` value the extraction walk saw around it. Their `[start, end)` offsets
 * are into `blockText(block, version)` — the same walk produces both — so the
 * build can resolve a token's reading context by locating the run its offset
 * falls in. Runs from other structure (line breaks, table separators) contribute
 * no span, but they never contain word characters, so no token can fall in one.
 */
export const tokenContexts = (
  block: Block,
  version: Version = "edited",
): ContextSpan[] => {
  const spans: ContextSpan[] = [];
  walkBlock(block, { pos: 0, ranges: [], version, spans });
  return spans;
};

/**
 * A copy of the block resolved to the given version (default edited), with
 * the given ranges of its extracted text wrapped in Markit `highlight`
 * elements (rendered as <mark> by renderHTML). The ranges must be measured
 * against `blockText(block, version)` and be sorted and non-overlapping (as
 * `matchRanges` produces them): the walk emits the same version, so offsets
 * line up. Only plainText nodes are ever split; characters contributed by other
 * elements are passed over, so a range spanning a line break or page break
 * simply resumes marking after it.
 */
export const highlightBlock = (
  block: Block,
  ranges: HighlightRange[],
  version: Version = "edited",
): Block => walkBlock(block, { pos: 0, ranges, version });

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
