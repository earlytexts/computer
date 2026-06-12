import { assert, assertEquals } from "@std/assert";
import { type Block, compile, type InlineElement } from "@earlytexts/markit";
import { blockText, highlightBlock } from "../../src/lib/text.ts";

/**
 * Compile a Markit document and return its blocks. The sample exercises
 * every extraction rule: wrappers, non-breaking spaces, mid-word page
 * breaks, footnote references, multi-line headings.
 */
const blocks = (): Block[] => {
  const [doc] = compile(`# Test.X

{#title}
^1 A SAMPLE
^2 for testing

{#1}
The _quick_ brown~fox ju//42//mps<n1> over the lazy dog.

{#n1}
A note.
`);
  return doc.blocks;
};

/** The text of every highlight element, in order. */
const marked = (block: Block): string[] => {
  const out: string[] = [];
  const walk = (elements: InlineElement[]): void => {
    for (const element of elements) {
      if (element.type === "plainText") continue;
      if (element.type === "highlight") out.push(inlineText(element.content));
      else if ("content" in element) walk(element.content);
    }
  };
  const inlineText = (elements: InlineElement[]): string =>
    elements.map((el) =>
      el.type === "plainText"
        ? el.content
        : "content" in el
        ? inlineText(el.content)
        : ""
    ).join("");
  for (const element of block.content) {
    if (element.type === "heading") {
      for (const line of element.content) walk(line.content);
    } else if (element.type === "paragraph") walk(element.content);
  }
  return out;
};

Deno.test("extraction strips formatting and synthetic elements", () => {
  const [title, paragraph, note] = blocks();
  assertEquals(blockText(title), "A SAMPLE\nfor testing");
  assertEquals(
    blockText(paragraph),
    "The quick brown fox jumps over the lazy dog.",
  );
  assertEquals(blockText(note), "A note.");
});

Deno.test("highlighting is transparent to extraction", () => {
  const paragraph = blocks()[1];
  const text = blockText(paragraph);
  for (
    const ranges of [
      [{ start: 0, end: text.length }],
      [{ start: 4, end: 25 }],
      [{ start: 0, end: 3 }, { start: 10, end: 19 }],
    ]
  ) {
    assertEquals(blockText(highlightBlock(paragraph, ranges)), text);
  }
});

Deno.test("a range spanning formatting marks each fragment", () => {
  const paragraph = blocks()[1];
  // "quick brown fox jumps" spans the emphasis wrapper, a non-breaking
  // space (synthetic, unmarkable), and a mid-word page break.
  const highlighted = highlightBlock(paragraph, [{ start: 4, end: 25 }]);
  assertEquals(marked(highlighted), ["quick", " brown", "fox ju", "mps"]);
});

Deno.test("a range spanning heading lines skips the line break", () => {
  const title = blocks()[0];
  // "SAMPLE\nfor" — the "\n" is contributed by the heading structure.
  const highlighted = highlightBlock(title, [{ start: 2, end: 12 }]);
  assertEquals(marked(highlighted), ["SAMPLE", "for"]);
});

Deno.test("overlapping ranges merge into one mark", () => {
  const paragraph = blocks()[1];
  const highlighted = highlightBlock(paragraph, [
    { start: 30, end: 35 },
    { start: 33, end: 39 },
  ]);
  assertEquals(marked(highlighted), [" the lazy"]);
});

Deno.test("empty ranges mark nothing", () => {
  const paragraph = blocks()[1];
  const highlighted = highlightBlock(paragraph, [{ start: 10, end: 10 }]);
  assertEquals(marked(highlighted), []);
  assertEquals(highlightBlock(paragraph, []), paragraph);
});

Deno.test("highlighting does not mutate the original block", () => {
  const paragraph = blocks()[1];
  const before = JSON.stringify(paragraph);
  highlightBlock(paragraph, [{ start: 0, end: 44 }]);
  assertEquals(JSON.stringify(paragraph), before);
  assert(marked(paragraph).length === 0);
});
