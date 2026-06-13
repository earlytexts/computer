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
 * regular Markit document — words and whole blocks only in edition A wrapped
 * in `deletion`, those only in B in `insertion` — so the API serves a diff
 * as ordinary blocks and clients render it with no diff-specific logic.
 */

import type { Block, InlineElement } from "@earlytexts/markit";
import { blockText, markBlock } from "./text.ts";
import { lastSegment } from "./catalog.ts";

export type Token = {
  text: string;
  /** Whether the token was preceded by whitespace in the source. */
  spaced: boolean;
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

export const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let lastEnd = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    tokens.push({
      text: match[0],
      spaced: match.index > lastEnd,
    });
    lastEnd = match.index + match[0].length;
  }
  return tokens;
};

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
  const push = (type: DiffOp["type"], tokens: Token[]) => {
    if (tokens.length === 0) return;
    const last = ops[ops.length - 1];
    if (last !== undefined && last.type === type) last.tokens.push(...tokens);
    else ops.push({ type, tokens: [...tokens] });
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
  while (x > 0 && y > 0) {
    reversed.push({ type: "equal", tokens: [a[x - 1]] });
    x--;
    y--;
  }
  while (x > 0) {
    reversed.push({ type: "delete", tokens: [a[x - 1]] });
    x--;
  }
  while (y > 0) {
    reversed.push({ type: "insert", tokens: [b[y - 1]] });
    y--;
  }

  const ops: DiffOp[] = [];
  for (let i = reversed.length - 1; i >= 0; i--) {
    const op = reversed[i];
    const last = ops[ops.length - 1];
    if (last !== undefined && last.type === op.type) {
      last.tokens.push(...op.tokens);
    } else ops.push({ type: op.type, tokens: [...op.tokens] });
  }
  return ops;
};

export const diffText = (a: string, b: string): DiffOp[] =>
  diffTokens(tokenize(a), tokenize(b));

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
            ops: diffText(textA, textB),
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

/** A changed block's ops as inline content: equal runs plain, deletes in
 * `deletion`, inserts in `insertion`. Formatting within the block is not
 * preserved (the diff is over extracted text), matching the prior behaviour. */
const opsToInline = (ops: DiffOp[]): InlineElement[] =>
  ops.flatMap((op): InlineElement[] => {
    const text = opText(op.tokens);
    if (text === "") return [];
    const plain: InlineElement = { type: "plainText", content: text };
    switch (op.type) {
      case "equal":
        return [plain];
      case "delete":
        return [{ type: "deletion", content: [plain] }];
      case "insert":
        return [{ type: "insertion", content: [plain] }];
    }
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
