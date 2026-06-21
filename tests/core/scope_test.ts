/**
 * The edition-scope contract (scope.ts): the validation and resolution shared by
 * the universe-filter routes. `editions` (canonical|all) chooses the universe;
 * `edition` (a year slug) names one printing and is only valid with a `work`.
 */

import { assertEquals } from "@std/assert";
import { editionFilter, resolveEditions, scopeError } from "../../src/scope.ts";

Deno.test("scopeError accepts the coherent combinations", () => {
  // The universe axis, at any scope.
  assertEquals(scopeError({}), undefined);
  assertEquals(scopeError({ editions: "canonical" }), undefined);
  assertEquals(scopeError({ editions: "all" }), undefined);
  // A specific printing, pinned to a single work.
  assertEquals(scopeError({ work: "epm", edition: "1751" }), undefined);
});

Deno.test("scopeError rejects the incoherent combinations", () => {
  // A bare year, with no work, ranges over many works' unrelated printings.
  const noWork = scopeError({ edition: "1751" });
  assertEquals(typeof noWork, "string");
  // The two ways of choosing editions cannot be combined.
  const both = scopeError({ work: "epm", edition: "1751", editions: "all" });
  assertEquals(typeof both, "string");
  // An unknown universe value.
  const bad = scopeError({ editions: "1751" });
  assertEquals(typeof bad, "string");
});

Deno.test("editionFilter resolves the two params to the internal filter", () => {
  // The universe: undefined = canonical, "all" = every printing.
  assertEquals(editionFilter({}), undefined);
  assertEquals(editionFilter({ editions: "canonical" }), undefined);
  assertEquals(editionFilter({ editions: "all" }), "all");
  // A specific printing wins (the params being mutually exclusive).
  assertEquals(editionFilter({ edition: "1751" }), "1751");
});

Deno.test("resolveEditions echoes the universe, defaulting to canonical", () => {
  assertEquals(resolveEditions({}), "canonical");
  assertEquals(resolveEditions({ editions: "canonical" }), "canonical");
  assertEquals(resolveEditions({ editions: "all" }), "all");
});
