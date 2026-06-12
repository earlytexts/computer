import { assertEquals } from "@std/assert";
import {
  diffText,
  diffTokens,
  type Token,
  tokenize,
} from "../../src/lib/diff.ts";

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
