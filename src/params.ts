/**
 * The query-parameter contract shared by the HTTP server (server.ts) and the MCP
 * tools (tools.ts). Where scope.ts owns the one cross-param rule (editions vs
 * edition), this module owns the per-param ones: an enum value must be on its
 * list, a count must be a whole number at or above its floor, a flag must be a
 * recognised truth word, and a route accepts no parameter it does not name.
 *
 * Each parser takes the raw value as received — a string from a URL query, a
 * native JSON value from an MCP argument, or `undefined`/`null`/`""` when absent
 * — and returns the typed value, or `undefined` for absent (so the response
 * builders in api.ts keep ownership of the defaults). A value that is present but
 * malformed throws `ParamError`; both boundaries translate that into their idiom
 * (a 400 over HTTP, an error result over MCP) instead of silently substituting a
 * default. Over-max counts are *not* rejected here — the builders clamp them to
 * the documented cap, a well-defined behaviour the interface keeps.
 *
 * Like scope.ts, this is deliberately dependency-free (it imports only the wire
 * types, which erase) so both boundaries can validate without pulling in the core.
 */

import type { KeyMode, MatchLevel, SimilarLevel, Version } from "./types.ts";

/**
 * A malformed parameter value. Distinct from any other error so the boundaries
 * can map it to a 400 (HTTP) or an error result (MCP) rather than a 500.
 */
export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

/** The enum value sets, kept in lockstep with the wire types they parse to. */
export const MATCH_LEVELS = [
  "exact",
  "spelling",
  "form",
] as const satisfies readonly MatchLevel[];
export const KEY_MODES = [
  "lemma",
  "form",
  "exact",
] as const satisfies readonly KeyMode[];
export const LEVELS = [
  "section",
  "edition",
  "work",
] as const satisfies readonly SimilarLevel[];
export const GROUP_BYS = ["author", "work", "edition"] as const;
export const SORTS = ["position", "left", "right"] as const;
/** search/frequency/concordance/keywords read live text but not the raw markup. */
export const SEARCH_VERSIONS = [
  "edited",
  "original",
] as const satisfies readonly Version[];
/** The reading routes additionally accept "both" (the raw editorial markup). */
export const TEXT_VERSIONS = [
  "edited",
  "original",
  "both",
] as const satisfies readonly Version[];

/** True for an absent value: missing, null, or the empty string. */
const absent = (raw: unknown): boolean =>
  raw === undefined || raw === null || raw === "";

const show = (raw: unknown): string =>
  typeof raw === "string" ? `"${raw}"` : String(raw);

/**
 * An enum parameter. Returns the value when it is on `allowed`, `undefined` when
 * absent (the builder defaults), and throws otherwise — no silent coercion to the
 * default.
 */
export const enumParam = <T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
): T | undefined => {
  if (absent(raw)) return undefined;
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new ParamError(
    `${name} must be one of ${
      allowed.map((value) => `"${value}"`).join(", ")
    } (got ${show(raw)}).`,
  );
};

/**
 * A count parameter: a whole number at or above `min` (1 by default). Rejects the
 * non-numeric, the fractional, and the below-floor; passes an over-max value
 * through unchanged for the builder to clamp to its documented cap.
 */
export const intParam = (
  name: string,
  raw: unknown,
  min = 1,
): number | undefined => {
  if (absent(raw)) return undefined;
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && /^[+-]?\d+$/.test(raw.trim())) {
    n = Number(raw);
  } else {
    throw new ParamError(`${name} must be a whole number (got ${show(raw)}).`);
  }
  if (!Number.isInteger(n)) {
    throw new ParamError(`${name} must be a whole number (got ${show(raw)}).`);
  }
  if (n < min) {
    throw new ParamError(`${name} must be at least ${min} (got ${n}).`);
  }
  return n;
};

/**
 * A boolean flag. Accepts a native boolean (an MCP argument) or one of the truth
 * words `1`/`0`/`true`/`false` (a URL query, case-insensitive); throws on anything
 * else rather than reading an unrecognised value as false.
 */
export const boolParam = (name: string, raw: unknown): boolean | undefined => {
  if (absent(raw)) return undefined;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const value = raw.toLowerCase();
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
  }
  throw new ParamError(
    `${name} must be true or false (got ${show(raw)}).`,
  );
};

/**
 * Reject any query parameter a route does not name — so a misspelling
 * (`?cassSensitive=1`) is an error, not a silently ignored no-op that returns
 * defaults. The single source of "this route's parameters are exactly these".
 */
export const rejectUnknownParams = (
  params: URLSearchParams,
  allowed: readonly string[],
): void => {
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      throw new ParamError(
        `unknown query parameter "${key}". Allowed: ${
          [...allowed].sort().join(", ")
        }.`,
      );
    }
  }
};

/**
 * Reject any MCP argument a tool does not declare. The tool schemas already set
 * `additionalProperties: false`, but the handler does not validate against the
 * schema at call time, so this closes the same gap the HTTP allowlist does.
 */
export const rejectUnknownArgs = (
  input: Record<string, unknown>,
  allowed: readonly string[],
): void => {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new ParamError(
        `unknown argument "${key}". Allowed: ${
          [...allowed].sort().join(", ")
        }.`,
      );
    }
  }
};
