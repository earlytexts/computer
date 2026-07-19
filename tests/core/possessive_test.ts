/**
 * The possessive rule on the read side: a regular possessive needs no entry of
 * its own. Indexing files `xxx's` under `xxx`'s lemma when `xxx` is registered
 * (and leaves it as itself otherwise), so a form search for the base reaches
 * the possessive; and a form query typed as a possessive that never occurs
 * still reaches its base. Uses `possessiveCorpus`, where only "bishop" is
 * registered.
 */

import { assertEquals } from "@std/assert";
import { openTestComputer } from "../helpers.ts";
import { possessiveCorpus } from "../corpus.ts";

const open = () => openTestComputer(possessiveCorpus());

Deno.test("a form search for the base reaches its possessive", async () => {
  const { computer } = await open();
  // "bishop's" (registered base) indexes under lemma "bishop", so a form search
  // for "bishop" reaches the one block — matching both "bishop's" and "bishop".
  assertEquals(
    (await computer.search({ q: "bishop", match: "form" })).total,
    1,
  );
  // The possessive is still its own surface, found verbatim.
  assertEquals(
    (await computer.search({ q: "bishop's", match: "exact" })).total,
    1,
  );
  // And a form query for the possessive collapses to the same lemma.
  assertEquals(
    (await computer.search({ q: "bishop's", match: "form" })).total,
    1,
  );
});

Deno.test("a possessive of an unregistered base indexes as itself", async () => {
  const { computer } = await open();
  // "wombat" is not registered, so "wombat's" stays itself: found exact, but a
  // form query for the bare base finds nothing (the base never occurs).
  assertEquals(
    (await computer.search({ q: "wombat's", match: "exact" })).total,
    1,
  );
  assertEquals(
    (await computer.search({ q: "wombat", match: "form" })).total,
    0,
  );
});

Deno.test("a possessive query reaches a base that occurs only bare", async () => {
  const { computer } = await open();
  // "mitre" occurs only bare (never as "mitre's"), so the query "mitre's" is no
  // surface — the possessive rule routes it to the base's lemma and finds it.
  assertEquals(
    (await computer.search({ q: "mitre's", match: "form" })).total,
    1,
  );
  // A possessive whose base never occurs, and a plain absent word, find nothing.
  assertEquals(
    (await computer.search({ q: "dragon's", match: "form" })).total,
    0,
  );
  assertEquals(
    (await computer.search({ q: "dragon", match: "form" })).total,
    0,
  );
});
