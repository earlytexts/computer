import { assert, assertEquals } from "@std/assert";
import { compile } from "@earlytexts/markit";
import {
  diffBlocks,
  diffText,
  diffToBlocks,
  diffTokens,
  type Token,
  tokenize,
} from "../../src/lib/diff.ts";

/** The text of every element of the given type, anywhere in a value. */
const ofType = (value: unknown, type: string): string[] => {
  if (Array.isArray(value)) return value.flatMap((v) => ofType(v, type));
  if (typeof value !== "object" || value === null) return [];
  const el = value as Record<string, unknown>;
  if (el.type === "plainText") return [];
  if (el.type === type) {
    return [
      (el.content as { content: string }[] ?? [])
        .map((n) => n.content ?? "").join(""),
    ];
  }
  return ofType(el.content, type);
};

const words = (ops: ReturnType<typeof diffText>, type: string): string =>
  ops.filter((op) => op.type === type)
    .flatMap((op) => op.tokens.map((t) => t.text))
    .join(" ");

Deno.test("tokenize splits words and punctuation, tracking spacing", () => {
  const tokens = tokenize("Good; as others, 'tis fine.");
  assertEquals(tokens.map((t) => t.text), [
    "Good",
    ";",
    "as",
    "others",
    ",",
    "'tis",
    "fine",
    ".",
  ]);
  assertEquals(tokens.map((t) => t.spaced), [
    false,
    false,
    true,
    true,
    false,
    true,
    true,
    false,
  ]);
});

Deno.test("diff of identical texts is a single equal op", () => {
  const ops = diffText("the very same text", "the very same text");
  assertEquals(ops.length, 1);
  assertEquals(ops[0].type, "equal");
});

Deno.test("diff finds a single word substitution", () => {
  const ops = diffText(
    "it is impossible for it to rest",
    "it is difficult for it to rest",
  );
  assertEquals(words(ops, "delete"), "impossible");
  assertEquals(words(ops, "insert"), "difficult");
});

Deno.test("diff finds punctuation-only changes without marking words", () => {
  const ops = diffText(
    "according to the light, in which",
    "according to the light in which",
  );
  assertEquals(words(ops, "delete"), ",");
  assertEquals(words(ops, "insert"), "");
});

Deno.test("diff round-trips: equal+delete = a, equal+insert = b", () => {
  const a = tokenize("the quick brown fox jumps over the lazy dog");
  const b = tokenize("the slow brown fox leaps over a lazy dog today");
  const ops = diffTokens(a, b);
  const fromA = ops.filter((op) => op.type !== "insert")
    .flatMap((op) => op.tokens.map((t) => t.text));
  const fromB = ops.filter((op) => op.type !== "delete")
    .flatMap((op) => op.tokens.map((t) => t.text));
  assertEquals(fromA, a.map((t) => t.text));
  assertEquals(fromB, b.map((t) => t.text));
});

Deno.test("diff handles wholly different texts", () => {
  const a: Token[] = tokenize("alpha beta gamma");
  const b: Token[] = tokenize("delta epsilon");
  const ops = diffTokens(a, b);
  const equals = ops.filter((op) => op.type === "equal");
  assertEquals(equals.length, 0);
});

Deno.test("diff handles empty sides", () => {
  assertEquals(diffTokens([], []), []);
  assertEquals(diffTokens(tokenize("some text"), [])[0].type, "delete");
  assertEquals(diffTokens([], tokenize("some text"))[0].type, "insert");
});

Deno.test("diffToBlocks renders a diff as Markit editorial markup", () => {
  const a =
    compile(`# A\n\n{#1}\nthe quick brown fox\n\n{#2}\nonly in the first\n`)[0];
  const b = compile(`# A\n\n{#1}\nthe slow brown fox\n`)[0];
  const out = diffToBlocks(diffBlocks(a.blocks, b.blocks));
  const deletions = out.flatMap((blk) => ofType(blk.content, "deletion"));
  const insertions = out.flatMap((blk) => ofType(blk.content, "insertion"));
  // a word changed in #1: only in a is a deletion, only in b an insertion
  assert(deletions.some((t) => t.includes("quick")));
  assert(insertions.some((t) => t.includes("slow")));
  // #2 exists only in a: the whole block is wrapped in a deletion
  assert(deletions.some((t) => t.includes("only in the first")));
});
