/**
 * The edition-scope contract shared by the universe-filter routes — search,
 * frequency, concordance, keywords, and collocations. These routes range over
 * many works at once, so choosing editions splits into two orthogonal ideas,
 * one param each:
 *
 *   - `editions` — the universe: one canonical printing per work ("canonical",
 *     the default) or every printing ("all"). Coherent at any scope, because it
 *     never names a particular year.
 *   - `edition` — one specific printing (a year slug). Only meaningful for a
 *     single named `work`: a bare year ranges over many works' unrelated
 *     printings, which is what this split exists to forbid.
 *
 * This module is the single source of that rule. It is deliberately dependency
 * free so both the HTTP server and the MCP tools can validate at their boundary
 * without pulling in the core.
 */

/** The edition universe: one canonical printing per work, or every printing. */
export type Editions = "canonical" | "all";

/** The edition-scope params, as received (before validation/resolution). */
export type EditionScopeParams = {
  work?: string;
  edition?: string;
  editions?: string;
};

/**
 * Validate the two edition-scope params together. Returns a human-readable error
 * message for an incoherent combination, or `undefined` when the scope is sound:
 *
 *   - an `editions` value other than "canonical" or "all";
 *   - a specific `edition` with no `work` (a year across unrelated works);
 *   - `edition` and `editions` combined (two ways to choose editions at once).
 */
export const scopeError = (params: EditionScopeParams): string | undefined => {
  if (
    params.editions !== undefined &&
    params.editions !== "canonical" && params.editions !== "all"
  ) {
    return `editions must be "canonical" or "all" (got "${params.editions}").`;
  }
  if (params.edition !== undefined) {
    if (params.work === undefined) {
      return `edition "${params.edition}" names one printing of a single ` +
        `work — add a work, or use editions=all to range over every printing.`;
    }
    if (params.editions !== undefined) {
      return `edition (one specific printing) and editions (canonical or all) ` +
        `cannot be combined — use one or the other.`;
    }
  }
  return undefined;
};

/**
 * The resolved universe, for echoing back in a response: the user's `editions`
 * choice, defaulting to "canonical". (Independent of any specific `edition`,
 * which the two params being mutually exclusive keeps unambiguous.)
 */
export const resolveEditions = (params: { editions?: string }): Editions =>
  params.editions === "all" ? "all" : "canonical";

/**
 * Resolve the two params to the internal edition filter the core scoping uses: a
 * year slug for one printing, "all" for every printing, or `undefined` for the
 * canonical universe. Assumes the params have already passed `scopeError`.
 */
export const editionFilter = (
  params: { edition?: string; editions?: string },
): string | undefined =>
  params.edition !== undefined
    ? params.edition
    : params.editions === "all"
    ? "all"
    : undefined;
