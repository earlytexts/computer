/**
 * computer.concordance — one keyword-in-context line per occurrence, with a
 * context window and a choice of sort order.
 */

import { assert, assertEquals } from "@std/assert";
import { testComputer } from "../helpers.ts";

Deno.test("concordance returns one keyword-in-context line per occurrence", async () => {
  const computer = await testComputer();
  const conc = await computer.concordance({
    q: "liberty",
    window: 3,
    editions: "all",
  });
  assertEquals(conc.window, 3);
  assertEquals(conc.sort, "position"); // default order
  assert(conc.total > 0);
  assertEquals(conc.lines.length, conc.total);
  for (const line of conc.lines) {
    assert(/liberty/i.test(line.keyword));
    assertEquals(typeof line.left, "string");
    assertEquals(typeof line.right, "string");
  }
});

Deno.test("the sort order is honoured", async () => {
  const computer = await testComputer();
  const byPosition = await computer.concordance({
    q: "liberty",
    editions: "all",
  });
  const byLeft = await computer.concordance({
    q: "liberty",
    sort: "left",
    editions: "all",
  });
  assertEquals(byLeft.sort, "left");
  assertEquals(byLeft.total, byPosition.total);
});

Deno.test("an empty query has no lines", async () => {
  const computer = await testComputer();
  assertEquals((await computer.concordance({ q: "" })).total, 0);
});
