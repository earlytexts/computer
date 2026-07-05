/**
 * The extraction and diff seam over the rich corpus (every Markit inline and
 * block element) and the big-diff corpus (a word diff past its edit-distance
 * ceiling). Drives the `Computer` directly: reading and full text exercise the
 * plain-text walk over every element type; a section comparison exercises the
 * word diff, the inline-context regrouping, and the whole-block editorial
 * marking; a work comparison aligns added and removed sections.
 */

import { assert, assertEquals } from "@std/assert";
import { openTestComputer } from "../helpers.ts";
import { bigDiffCorpus, richCorpus } from "../corpus.ts";
import { ofType, textOf } from "../markit.ts";

Deno.test("rich: full text walks every block and inline element type", async () => {
  const { computer } = await openTestComputer(richCorpus());
  const full = await computer.fullText("rich", "anth", "1700");
  assert(full !== undefined);
  // The title block's multi-line heading, and the rich block's blockquote,
  // list and table, are all present in the rendered structure.
  const everything = [
    ...full.blocks,
    ...full.sections.flatMap((s) => collect(s)),
  ];
  const text = textOf(everything);
  assert(text.includes("ANTHOLOGY"));
  assert(text.includes("Apple"));
  assert(text.includes("alpha"));
  // Block content nested inside a quotation, a block-level stage direction,
  // and a raw element's inner text all survive the walk.
  assert(text.includes("quoted-alpha"));
  assert(text.includes("He sits"));
  assert(text.includes("marked pair"));
});

Deno.test("rich: a search match is highlighted inside its block", async () => {
  const { computer } = await openTestComputer(richCorpus());
  const search = await computer.search({ q: "maxim", editions: "all" });
  assert(search.total >= 1);
  const hit = search.results[0];
  assertEquals(ofType(hit.block, "highlight").join(""), "maxim");
});

Deno.test("rich: a section comparison diffs one changed paragraph and marks whole added/removed blocks", async () => {
  const { computer } = await openTestComputer(richCorpus());
  const diff = await computer.compareSection(
    "rich",
    "anth",
    "1700",
    "1710",
    ["1"],
  );
  assert(diff !== undefined);
  // The changed paragraph: ALPHA only in A (insertion), OMEGA only in B
  // (deletion) — A is the primary edition, so its text is the insertion side.
  assertEquals(
    ofType(diff.blocks, "insertion").join(" ").includes("ALPHA"),
    true,
  );
  assertEquals(
    ofType(diff.blocks, "deletion").join(" ").includes("OMEGA"),
    true,
  );
  // The equal run kept its inline formatting (emphasis, strong, foreign run,
  // and the raw element — rebuilt as one element around its two tokens).
  const equalText = textOf(diff.blocks);
  assert(equalText.includes("truly"));
  assert(equalText.includes("ipsa loquitur"));
  // (The group's leading space sits inside the rebuilt wrapper, as it does
  // for every regrouped wrapper type.)
  assertEquals(ofType(diff.blocks, "element").join(""), " marked pair");
  // The whole block present in only one edition is wrapped end to end —
  // including its blockquote's nested list, its stage direction, and its
  // table cells (the A-only block, the B-only block).
  assert(ofType(diff.blocks, "insertion").some((t) => t.includes("alpha")));
  assert(ofType(diff.blocks, "insertion").some((t) => t.includes("He sits")));
  assert(ofType(diff.blocks, "deletion").some((t) => t.includes("Apple")));

  // A section has a neighbour present in both editions (prev/next can't 404).
  assert(diff.next !== undefined || diff.prev !== undefined);
});

Deno.test("rich: a section comparison word-diffs paragraphs with edits and insertions", async () => {
  const { computer } = await openTestComputer(richCorpus());
  const diff = await computer.compareSection(
    "rich",
    "anth",
    "1700",
    "1710",
    ["2"],
  );
  assert(diff !== undefined);
  const deleted = ofType(diff.blocks, "deletion").join(" ");
  const inserted = ofType(diff.blocks, "insertion").join(" ");
  // {#myers}: common subsequence with edits on both sides. A is the primary
  // edition (insertion side), so its "beta" is an insertion and B's "zeta" a
  // deletion.
  assert(inserted.includes("beta"));
  assert(deleted.includes("zeta"));
  // {#ins}: a word only in the second edition ("two") shows as a deletion.
  assert(deleted.includes("two"));
  // The unchanged lemma paragraph survives whole (an equal block).
  assert(textOf(diff.blocks).includes("running"));
});

Deno.test("rich: search highlights every match, even around inline markup and when adjacent", async () => {
  const { computer } = await openTestComputer(richCorpus());
  // Two matches in one block split by an emphasis wrapper: the highlighter
  // walks past the earlier match to mark the later one.
  const liberty = await computer.search({ q: "liberty", editions: "all" });
  const libertyHit = liberty.results.find((r) => r.blockId === "hl");
  assert(libertyHit !== undefined);
  assertEquals(ofType(libertyHit.block, "highlight").length, 2);
  // Overlapping phrase matches ("echo echo" in "echo echo echo echo") merge
  // into contiguous marks rather than doubly wrapping.
  const echo = await computer.search({ q: "echo echo", editions: "all" });
  const echoHit = echo.results.find((r) => r.blockId === "echo");
  assert(echoHit !== undefined);
  assert(ofType(echoHit.block, "highlight").length >= 1);
});

Deno.test("rich: comparing an edition with itself is undefined", async () => {
  const { computer } = await openTestComputer(richCorpus());
  assertEquals(
    await computer.compareSection("rich", "anth", "1700", "1700", ["1"]),
    undefined,
  );
});

Deno.test("rich: a work comparison aligns shared, added, and removed sections", async () => {
  const { computer } = await openTestComputer(richCorpus());
  const compare = await computer.compare("rich", "anth", "1700", "1710");
  assert(compare !== undefined);
  const inBoth = compare.rows.filter((r) =>
    r.pathA !== undefined && r.pathB !== undefined
  );
  const onlyA = compare.rows.filter((r) => r.pathB === undefined);
  const onlyB = compare.rows.filter((r) => r.pathA === undefined);
  assert(inBoth.length >= 2); // sections 1 and 2
  assert(onlyA.length >= 1); // first edition's own section
  assert(onlyB.length >= 1); // second edition's own section
});

Deno.test("rich: a reading route keeps the editorial markup under version=both", async () => {
  const { computer } = await openTestComputer(richCorpus());
  const both = await computer.section("rich", "anth", "1700", ["1"], "both");
  assert(both !== undefined);
  // The markup survives untouched (resolveBlock returns the block as-is).
  assert(ofType(both.section.blocks, "deletion").join("").includes("mistook"));
  assert(
    ofType(both.section.blocks, "insertion").join("").includes("corrected"),
  );
  // The edited reading text drops the deletion and keeps the insertion.
  const edited = await computer.section(
    "rich",
    "anth",
    "1700",
    ["1"],
    "edited",
  );
  const editedText = textOf(edited!.section.blocks);
  assert(!editedText.includes("mistook"));
  assert(editedText.includes("corrected"));
});

Deno.test("big diff: a wholly disjoint block falls back to delete-all/insert-all", async () => {
  const { computer } = await openTestComputer(bigDiffCorpus());
  const diff = await computer.compareSection("big", "tome", "1700", "1710", [
    "1",
  ]);
  assert(diff !== undefined);
  // A (1700, "alpha") is the primary edition, so its text is the insertion side
  // and B (1710, "omega") the deletion side.
  assert(ofType(diff.blocks, "insertion").some((t) => t.includes("alpha0")));
  assert(ofType(diff.blocks, "deletion").some((t) => t.includes("omega0")));
});

/** Every block under a section content node, depth-first. */
// deno-lint-ignore no-explicit-any
const collect = (section: any): unknown[] => [
  ...section.blocks,
  ...section.children.flatMap(collect),
];
