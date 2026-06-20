/**
 * computer.frequency — per-group occurrence counts with a relative rate, grouped
 * by author, work, or edition.
 */

import { assert, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";

Deno.test("frequency groups occurrences by work with a relative rate", async () => {
  const computer = await testComputer();
  const byWork = await computer.frequency({
    q: "liberty",
    by: "work",
    edition: "all",
  });
  assertEquals(byWork.by, "work");
  assert(byWork.total > 0);
  assert(byWork.results.length > 0);
  // grouped by work: no edition dimension
  assert(byWork.results.every((r) => r.edition === null));
  // the total is the sum across groups, results sorted by count descending
  assertEquals(byWork.total, byWork.results.reduce((n, r) => n + r.count, 0));
  for (let i = 1; i < byWork.results.length; i++) {
    assert(byWork.results[i - 1].count >= byWork.results[i].count);
  }
  // the relative rate is occurrences per 1000 tokens, to one decimal
  for (const r of byWork.results) {
    assertEquals(r.relative, Math.round((r.count / r.tokens) * 1000 * 10) / 10);
  }
});

Deno.test("by=edition adds the edition dimension", async () => {
  const computer = await testComputer();
  const byEdition = await computer.frequency({
    q: "liberty",
    by: "edition",
    edition: "all",
  });
  assertEquals(byEdition.by, "edition");
  assert(byEdition.results.every((r) => r.edition !== null));
});

Deno.test("an empty query has no occurrences", async () => {
  const computer = await testComputer();
  assertEquals((await computer.frequency({ q: "" })).total, 0);
});
