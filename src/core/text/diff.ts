/**
 * Word-level diffing between two editions of a text.
 *
 * Text is tokenized into words and individual punctuation marks (so a
 * changed comma marks only the comma, not the whole word), then compared
 * with the Myers O(ND) algorithm. Sections are compared block-by-block:
 * paragraphs are aligned by their Markit block ids ({#1}, {#n2}, ...) and
 * word-diffed individually.
 *
 * The diff is an internal representation. `diffToBlocks` turns it into a
 * regular Markit document — words and whole blocks only in the first argument
 * wrapped in `deletion`, those only in the second in `insertion` — so the API
 * serves a diff as ordinary blocks and clients render it with no diff-specific
 * logic. (compareSection passes the primary edition second so its text is the
 * insertion side; see api.ts.)
 */

import type {
  Block,
  InlineElement,
  List,
  WrapperType,
} from "@earlytexts/markit";
import { blockText, markBlock } from "./text.ts";
import { lastSegment } from "../build/catalog.ts";

/** A wrapper inline element enclosing a token, minus its content. */
type ContextFrame =
  | { type: WrapperType }
  | { type: "language"; lang?: string }
  | { type: "highlight" };

export type Token = {
  text: string;
  /** Whether the token was preceded by whitespace in the source. */
  spaced: boolean;
  /** Wrapper context of this token (outermost first). Set by tokenizeBlock;
   *  absent for tokens from tokenize(). */
  context?: ContextFrame[];
};

export type DiffOp = {
  type: "equal" | "delete" | "insert";
  tokens: Token[];
};

export type BlockDiff =
  | { type: "equal"; id: string; a: Block; b: Block }
  | { type: "changed"; id: string; a: Block; b: Block; ops: DiffOp[] }
  | { type: "deleted"; id: string; a: Block }
  | { type: "inserted"; id: string; b: Block };

const TOKEN_RE = /[\p{L}\p{N}'’—&-]+|[^\s\p{L}\p{N}]/gu;

/** Beyond this edit distance we give up and report delete-all/insert-all. */
const MAX_EDIT_DISTANCE = 3000;

/**
 * Myers greedy diff. Returns a minimal edit script as a list of ops over
 * tokens; "delete" tokens come from `a`, "insert" tokens from `b`.
 */
export const diffTokens = (a: Token[], b: Token[]): DiffOp[] => {
  // Trim common prefix and suffix first; most paragraphs differ only a little.
  let start = 0;
  while (
    start < a.length && start < b.length && a[start].text === b[start].text
  ) start++;
  let endA = a.length;
  let endB = b.length;
  while (
    endA > start && endB > start && a[endA - 1].text === b[endB - 1].text
  ) {
    endA--;
    endB--;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);

  const ops: DiffOp[] = [];
  // The prefix and suffix are equal; the middle's myers ops already begin and
  // end with a non-equal op (the trim guarantees the middle ends differ), so no
  // two pushes are ever the same type — a plain append suffices.
  const push = (type: DiffOp["type"], tokens: Token[]) => {
    if (tokens.length === 0) return;
    ops.push({ type, tokens: [...tokens] });
  };

  push("equal", a.slice(0, start));
  for (const op of myers(middleA, middleB)) push(op.type, op.tokens);
  push("equal", a.slice(endA));
  return ops;
};

const myers = (a: Token[], b: Token[]): DiffOp[] => {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: "insert", tokens: b }];
  if (m === 0) return [{ type: "delete", tokens: a }];

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  // v[k + offset] = furthest x on diagonal k; trace stores a copy per step.
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]))
        ? v[k + 1 + offset]
        : v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < n && y < m && a[x].text === b[y].text) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) break outer;
    }
    if (d === max) {
      // Edit distance too large; not worth a fine-grained diff.
      return [
        { type: "delete", tokens: a },
        { type: "insert", tokens: b },
      ];
    }
  }

  // Backtrack through the trace to recover the edit script (in reverse).
  const reversed: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const prevK =
      (k === -d || (k !== d && prev[k - 1 + offset] < prev[k + 1 + offset]))
        ? k + 1
        : k - 1;
    const prevX = prev[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: "equal", tokens: [a[x - 1]] });
      x--;
      y--;
    }
    if (x === prevX) {
      reversed.push({ type: "insert", tokens: [b[y - 1]] });
      y--;
    } else {
      reversed.push({ type: "delete", tokens: [a[x - 1]] });
      x--;
    }
  }
  // No leading-snake tail to recover: diffTokens trims the common prefix before
  // calling myers, so the backtrack always lands exactly at the origin.

  // Reverse into reading order, merging adjacent ops of the same type.
  return reversed.reverse().reduce<DiffOp[]>((ops, op) => {
    const last = ops[ops.length - 1];
    if (last !== undefined && last.type === op.type) {
      last.tokens.push(...op.tokens);
    } else ops.push({ type: op.type, tokens: [...op.tokens] });
    return ops;
  }, []);
};

/** A contiguous run of characters sharing one inline wrapper context. */
type TextSpan = { start: number; end: number; context: ContextFrame[] };

/**
 * Parallel to blockText but records the inline context of each character span.
 * The concatenated span texts equal blockText(block) for a pre-resolved block.
 */
const buildSpans = (block: Block): { text: string; spans: TextSpan[] } => {
  let text = "";
  const spans: TextSpan[] = [];

  // Every caller passes a non-empty string (Markit never emits empty plainText,
  // and the joiners/leaves are constants), so each call records a real span.
  const add = (s: string, ctx: ContextFrame[]): void => {
    spans.push({
      start: text.length,
      end: text.length + s.length,
      context: ctx,
    });
    text += s;
  };

  const inlineCtx = (elements: InlineElement[], ctx: ContextFrame[]): void => {
    for (const el of elements) {
      if (el.type === "plainText") {
        add(el.content, ctx);
      } else if (el.type === "lineBreak") {
        add("\n", ctx);
      } else if (el.type === "emSpace" || el.type === "nbSpace") {
        add(" ", ctx);
      } else if (el.type === "illegible") {
        add("[...]", ctx);
      } else if (el.type === "language") {
        inlineCtx(el.content, [...ctx, { type: "language", lang: el.lang }]);
      } else if ("content" in el) {
        // Wrapper: el is narrowed to Wrapper, el.type is WrapperType
        inlineCtx(el.content, [...ctx, { type: el.type }]);
      }
      // pageBreak, footnoteReference: contribute nothing
    }
  };

  const listBlock = (list: List): void => {
    list.items.forEach((item, i) => {
      if (i > 0) add("\n", []);
      inlineCtx(item.content, []);
      if (item.nestedList !== undefined) {
        add("\n", []);
        listBlock(item.nestedList);
      }
    });
  };

  block.content.forEach((el, i) => {
    if (i > 0) add("\n", []);
    switch (el.type) {
      case "paragraph":
        inlineCtx(el.content, []);
        break;
      case "heading":
        el.content.forEach((line, j) => {
          if (j > 0) add("\n", []);
          inlineCtx(line.content, []);
        });
        break;
      case "blockquote":
        el.content.forEach((para, j) => {
          if (j > 0) add("\n", []);
          inlineCtx(para.content, []);
        });
        break;
      case "list":
        listBlock(el);
        break;
      case "table":
        el.rows.forEach((row, j) => {
          if (j > 0) add("\n", []);
          row.cells.forEach((cell, k) => {
            if (k > 0) add(" | ", []);
            inlineCtx(cell.content, []);
          });
        });
        break;
    }
  });

  return { text, spans };
};

/**
 * Like tokenize but applied to a pre-resolved Block, annotating each token
 * with its inline wrapper context so opsToInline can reconstruct formatting.
 */
const tokenizeBlock = (block: Block): Token[] => {
  const { text, spans } = buildSpans(block);
  const tokens: Token[] = [];
  let lastEnd = 0;
  let si = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const idx = match.index!;
    // Advance to the span that covers idx (spans are in order, non-overlapping).
    while (si < spans.length - 1 && spans[si + 1].start <= idx) si++;
    tokens.push({
      text: match[0],
      spaced: idx > lastEnd,
      // Every character of `text` was recorded as a span, so the covering span
      // for this match always exists.
      context: spans[si]!.context,
    });
    lastEnd = idx + match[0].length;
  }
  return tokens;
};

/**
 * Diff two lists of blocks (two editions of one section). Blocks are
 * aligned by the order-preserving Myers diff of their id sequences, then
 * paired blocks are word-diffed.
 */
export const diffBlocks = (a: Block[], b: Block[]): BlockDiff[] => {
  const idTokens = (blocks: Block[]): Token[] =>
    blocks.map((block) => ({
      text: lastSegment(block.id).toLowerCase(),
      spaced: false,
    }));
  const result: BlockDiff[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of diffTokens(idTokens(a), idTokens(b))) {
    for (const _token of op.tokens) {
      if (op.type === "equal") {
        const blockA = a[ai++];
        const blockB = b[bi++];
        const textA = blockText(blockA);
        const textB = blockText(blockB);
        const id = lastSegment(blockB.id);
        if (textA === textB) {
          result.push({ type: "equal", id, a: blockA, b: blockB });
        } else {
          result.push({
            type: "changed",
            id,
            a: blockA,
            b: blockB,
            ops: diffTokens(tokenizeBlock(blockA), tokenizeBlock(blockB)),
          });
        }
      } else if (op.type === "delete") {
        const blockA = a[ai++];
        result.push({ type: "deleted", id: lastSegment(blockA.id), a: blockA });
      } else {
        const blockB = b[bi++];
        result.push({
          type: "inserted",
          id: lastSegment(blockB.id),
          b: blockB,
        });
      }
    }
  }
  return result;
};

/** Reconstruct an op's text, restoring the whitespace before each token. */
const opText = (tokens: Token[]): string =>
  tokens.map((token) => (token.spaced ? " " : "") + token.text).join("");

/** Two context stacks are equal when the same wrappers appear in the same order. */
const contextsEqual = (a: ContextFrame[], b: ContextFrame[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type) return false;
    if (a[i].type === "language") {
      const al = (a[i] as { lang?: string }).lang;
      const bl = (b[i] as { lang?: string }).lang;
      if (al !== bl) return false;
    }
  }
  return true;
};

/** A changed block's ops as inline content: equal runs preserve their inline
 * formatting (emphasis, strong, quote, language, etc.) by grouping tokens that
 * share the same context and re-wrapping them; deletes go in `deletion` and
 * inserts in `insertion` as plain text (graceful fallback for changed spans). */
const opsToInline = (ops: DiffOp[]): InlineElement[] =>
  ops.flatMap((op): InlineElement[] => {
    if (op.type !== "equal") {
      // op.tokens is always non-empty (myers never emits an empty op) and every
      // token carries non-empty text, so opText is never "".
      const plain: InlineElement = {
        type: "plainText",
        content: opText(op.tokens),
      };
      return op.type === "delete"
        ? [{ type: "deletion", content: [plain] }]
        : [{ type: "insertion", content: [plain] }];
    }
    // Equal op: group consecutive tokens by context, reconstruct wrapper elements.
    const result: InlineElement[] = [];
    let i = 0;
    while (i < op.tokens.length) {
      // These ops come from tokenizeBlock, which annotates every token with its
      // wrapper context, so context is always present here.
      const ctx = op.tokens[i].context!;
      let j = i + 1;
      while (
        j < op.tokens.length &&
        contextsEqual(op.tokens[j].context!, ctx)
      ) j++;
      const text = opText(op.tokens.slice(i, j));
      if (text !== "") {
        // Build from innermost to outermost (ctx[0] = outermost).
        let inner: InlineElement = { type: "plainText", content: text };
        for (let k = ctx.length - 1; k >= 0; k--) {
          inner = { ...ctx[k], content: [inner] } as InlineElement;
        }
        result.push(inner);
      }
      i = j;
    }
    return result;
  });

/**
 * Turn a block-level diff into a Markit document: the changes are expressed
 * with Markit's own editorial markup, so the result renders exactly like the
 * within-edition diff a `?version=both` retrieval returns.
 */
export const diffToBlocks = (diffs: BlockDiff[]): Block[] =>
  diffs.map((diff): Block => {
    switch (diff.type) {
      case "equal":
        return diff.b;
      case "changed":
        return {
          ...diff.b,
          content: [{ type: "paragraph", content: opsToInline(diff.ops) }],
        };
      case "deleted":
        return markBlock(diff.a, "deletion");
      case "inserted":
        return markBlock(diff.b, "insertion");
    }
  });
