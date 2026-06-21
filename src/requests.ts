/**
 * Build each `Computer` `*Params` object from a raw key→value source, shared by
 * the two boundaries that receive requests: the HTTP server (a URL query) and
 * the MCP tools (a JSON argument object). Both feed the same per-param parsers
 * (params.ts) and the same cross-param scope rule (scope.ts); the only thing
 * that differs is where a value comes from — `p.get(key)` over HTTP, `input[key]`
 * over MCP — captured by a `RawSource`. Stating each param list here exactly once
 * is what keeps the surfaces from drifting (the wire type, the HTTP route, and
 * the MCP tool of one method can no longer disagree about which params it takes).
 *
 * Required fields (a search `q`, a target `author`/`work`) are read leniently
 * here — absent becomes `""` or undefined, the contract the response builders in
 * api.ts already default over. The MCP tools layer adds its friendlier "missing
 * required argument" check on top; the HTTP server keeps its lenient behaviour.
 */

import {
  boolParam,
  enumParam,
  GROUP_BYS,
  intParam,
  KEY_MODES,
  LEVELS,
  MATCH_LEVELS,
  ParamError,
  SEARCH_VERSIONS,
  SORTS,
} from "./params.ts";
import { scopeError } from "./scope.ts";
import type {
  CollocationsParams,
  ConcordanceParams,
  FrequencyParams,
  KeywordsParams,
  SearchParams,
  SimilarParams,
  TopicMixParams,
  TopicsParams,
} from "./types.ts";

/** A raw request value by name: a URL query param (HTTP) or an argument (MCP). */
export type RawSource = (key: string) => unknown;

/** A present, non-empty string, else undefined (the builders own the defaults). */
const string = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw !== "" ? raw : undefined;

/**
 * A section path in either surface's idiom: a native string array (an MCP
 * argument) or a "/"-joined string (a URL query). Empty segments are dropped;
 * an empty path becomes undefined (the builders treat it as "no path given").
 */
const pathParam = (raw: unknown): string[] | undefined => {
  const parts = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string" && s !== "")
    : typeof raw === "string"
    ? raw.split("/").filter((s) => s !== "")
    : [];
  return parts.length > 0 ? parts : undefined;
};

/**
 * The validated edition-scope trio shared by the universe-filter routes. Throws
 * a `ParamError` (→ 400 / tool error) on an incoherent combination; see scope.ts.
 */
const scope = (
  get: RawSource,
): { work?: string; edition?: string; editions?: "canonical" | "all" } => {
  const work = string(get("work"));
  const edition = string(get("edition"));
  const editions = string(get("editions"));
  const err = scopeError({ work, edition, editions });
  if (err !== undefined) throw new ParamError(err);
  return {
    work,
    edition,
    editions: editions as "canonical" | "all" | undefined,
  };
};

export const searchParams = (get: RawSource): SearchParams => ({
  q: string(get("q")) ?? "",
  match: enumParam("match", get("match"), MATCH_LEVELS),
  caseSensitive: boolParam("caseSensitive", get("caseSensitive")),
  version: enumParam("version", get("version"), SEARCH_VERSIONS),
  author: string(get("author")),
  ...scope(get),
  page: intParam("page", get("page")),
  perPage: intParam("perPage", get("perPage")),
});

export const frequencyParams = (get: RawSource): FrequencyParams => ({
  q: string(get("q")) ?? "",
  groupBy: enumParam("groupBy", get("groupBy"), GROUP_BYS),
  match: enumParam("match", get("match"), MATCH_LEVELS),
  caseSensitive: boolParam("caseSensitive", get("caseSensitive")),
  version: enumParam("version", get("version"), SEARCH_VERSIONS),
  author: string(get("author")),
  ...scope(get),
});

export const concordanceParams = (get: RawSource): ConcordanceParams => ({
  q: string(get("q")) ?? "",
  window: intParam("window", get("window")),
  sort: enumParam("sort", get("sort"), SORTS),
  match: enumParam("match", get("match"), MATCH_LEVELS),
  caseSensitive: boolParam("caseSensitive", get("caseSensitive")),
  version: enumParam("version", get("version"), SEARCH_VERSIONS),
  author: string(get("author")),
  ...scope(get),
  page: intParam("page", get("page")),
  perPage: intParam("perPage", get("perPage")),
});

export const keywordsParams = (get: RawSource): KeywordsParams => ({
  author: string(get("author")),
  ...scope(get),
  by: enumParam("by", get("by"), KEY_MODES),
  version: enumParam("version", get("version"), SEARCH_VERSIONS),
  min: intParam("min", get("min")),
  limit: intParam("limit", get("limit")),
});

export const collocationsParams = (get: RawSource): CollocationsParams => ({
  q: string(get("q")) ?? "",
  by: enumParam("by", get("by"), KEY_MODES),
  match: enumParam("match", get("match"), MATCH_LEVELS),
  window: intParam("window", get("window")),
  min: intParam("min", get("min")),
  limit: intParam("limit", get("limit")),
  author: string(get("author")),
  ...scope(get),
});

export const similarParams = (get: RawSource): SimilarParams => ({
  author: string(get("author")),
  work: string(get("work")),
  edition: string(get("edition")),
  path: pathParam(get("path")),
  level: enumParam("level", get("level"), LEVELS),
  limit: intParam("limit", get("limit")),
});

export const topicsParams = (get: RawSource): TopicsParams => ({
  terms: intParam("terms", get("terms")),
  works: intParam("works", get("works")),
});

// topic/mix takes the same target shape as similar (author/work/edition/path/
// level/limit), so it shares the builder.
export const topicMixParams = (get: RawSource): TopicMixParams =>
  similarParams(get);
