/**
 * computer.similar — lexical similarity: the corpus items whose TF-IDF vectors
 * are closest (cosine) to a target section, edition, or work. The vectors come
 * from the DTM artefact, read lazily; here we pin the wire contract — the level
 * granularity, the canonical-edition universe, the exclusion of the target's own
 * work, and a score that ranks descending in [0, 1].
 */

import { assert, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";

/** Every score is a cosine in (0, 1], ordered descending. */
const assertRanked = (results: { score: number }[]): void => {
  for (const r of results) {
    assert(r.score > 0 && r.score <= 1, `score out of range: ${r.score}`);
  }
  for (let i = 1; i < results.length; i++) {
    assert(results[i - 1].score >= results[i].score, "scores descending");
  }
};

Deno.test("a section finds similar sections in other works", async () => {
  const computer = await testComputer();
  // Section 1 of the Test Work (canonical 1760): objects, sensation, passion.
  const response = await computer.similar({
    author: "test",
    work: "tw",
    path: ["1"],
  });
  assertEquals(response.level, "section"); // inferred from the path
  assertEquals(response.author, "test");
  assertEquals(response.work, "tw");
  assertEquals(response.edition, "1760"); // tw's canonical edition
  assertEquals(response.sectionPath, ["1"]);
  assert(response.found);
  assertEquals(response.total, response.results.length);
  assert(response.results.length > 0);
  // The target's own work never appears; results carry a section path + title.
  for (const r of response.results) {
    assert(r.work !== "tw", "the target work is excluded");
    assert(r.edition !== null);
    assert(r.sectionPath.length >= 0);
  }
  assert(response.results.some((r) => r.work === "solo"));
  assertRanked(response.results);
});

Deno.test("the work level compares whole works", async () => {
  const computer = await testComputer();
  const response = await computer.similar({
    author: "test",
    work: "tw",
    level: "work",
  });
  assertEquals(response.level, "work");
  assertEquals(response.edition, null); // a work has no single edition
  assertEquals(response.sectionPath, []);
  assert(response.found);
  // Candidates are other works (drawn from their canonical editions); each
  // appears once, at the work level (no edition or section).
  const works = new Set<string>();
  for (const r of response.results) {
    assert(r.work !== "tw");
    assertEquals(r.edition, null);
    assertEquals(r.sectionPath, []);
    works.add(`${r.authors[0]}/${r.work}`);
  }
  assertEquals(works.size, response.results.length);
  assert(works.has("test/solo"));
  assertRanked(response.results);
});

Deno.test("the edition level defaults to the canonical edition", async () => {
  const computer = await testComputer();
  const response = await computer.similar({ author: "test", work: "tw" });
  assertEquals(response.level, "edition"); // no path → edition
  assertEquals(response.edition, "1760");
  assert(response.found);
  for (const r of response.results) {
    assert(r.work !== "tw");
    assert(r.edition !== null);
    assertEquals(r.sectionPath, []);
  }
  assertRanked(response.results);
});

Deno.test("limit caps the number of items returned", async () => {
  const computer = await testComputer();
  const response = await computer.similar({
    author: "test",
    work: "tw",
    path: ["1"],
    limit: 1,
  });
  assert(response.results.length <= 1);
});

Deno.test("a missing target is reported as not found", async () => {
  const computer = await testComputer();
  const unknownWork = await computer.similar({ author: "test", work: "nope" });
  assert(!unknownWork.found);
  assertEquals(unknownWork.results.length, 0);

  const unknownSection = await computer.similar({
    author: "test",
    work: "tw",
    path: ["does", "not", "exist"],
  });
  assert(!unknownSection.found);
  assertEquals(unknownSection.results.length, 0);

  const noTarget = await computer.similar({});
  assert(!noTarget.found);
  assertEquals(noTarget.results.length, 0);
});
