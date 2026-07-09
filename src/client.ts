/**
 * A general-purpose typed client for the computer's HTTP API, shipped with the
 * computer so its callers (davidhume, englishphilosophy, companion) share one
 * implementation and one set of contract types instead of vendoring copies.
 *
 * Methods return undefined for 404s (the caller renders its own not-found page)
 * and throw for anything else (network failure, 5xx); use isComputerUnavailable
 * to tell "the computer could not serve us" from a bug on our side.
 *
 * The client is multi-author: every text request names its author, matching the
 * computer's `/authors/:author/...` routes. A single-author site can wrap this
 * with its own author-scoped facade.
 *
 * The catalogue rarely changes (only on a computer redeploy), so it is cached per
 * base URL for a minute to spare one round-trip per page view.
 */

import type { CatalogueResponse, Computer, Version } from "./types.ts";

const CATALOG_TTL_MS = 60_000;
const catalogueCache = new Map<
  string,
  { at: number; value: CatalogueResponse }
>();

const segment = (s: string): string => encodeURIComponent(s);

/**
 * A query string (with leading "?", or "" when empty) from named values, the
 * inverse of the server's request parsing. A value that is absent — undefined,
 * or `false` (a flag is only ever sent when true) — is dropped; a `true` becomes
 * "1" (the truth word the server reads), and numbers stringify. An empty string
 * is kept (an empty `q` is a real query), so only undefined drops a string.
 */
const qs = (
  params: Record<string, string | number | boolean | undefined>,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false) continue;
    query.set(key, value === true ? "1" : String(value));
  }
  const s = query.toString();
  return s === "" ? "" : `?${s}`;
};

/** Append ?version unless it is the default (edited). */
const withVersion = (path: string, version?: Version): string =>
  version === undefined || version === "edited"
    ? path
    : `${path}?version=${version}`;

/** Build an error marking the computer (not the caller) as the failure. */
export const computerUnavailable = (detail: string): Error =>
  Object.assign(new Error(`computer unavailable: ${detail}`), {
    computerUnavailable: true,
  });

/** True for errors meaning the computer could not serve us (vs. our bugs). */
export const isComputerUnavailable = (error: unknown): boolean =>
  error instanceof Error && "computerUnavailable" in error;

export const computerClient = (
  baseUrl: string,
  clientIp?: string,
): Computer => {
  const get = async <T>(path: string): Promise<T | undefined> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        headers: clientIp === undefined ? {} : { "x-forwarded-for": clientIp },
      });
    } catch (error) {
      throw computerUnavailable(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw computerUnavailable(`${response.status} for ${path}`);
    }
    return await response.json() as T;
  };

  const must = async <T>(path: string): Promise<T> => {
    const value = await get<T>(path);
    if (value === undefined) throw new Error(`computer has no ${path}`);
    return value;
  };

  const workBase = (author: string, work: string) =>
    `/authors/${segment(author)}/${segment(work)}`;
  // A year-shaped segment names the edition; omitting it addresses the work's
  // canonical edition (resolved by the computer).
  const editionBase = (author: string, work: string, edition?: string) =>
    edition === undefined
      ? workBase(author, work)
      : `${workBase(author, work)}/${segment(edition)}`;
  return {
    catalogue: async () => {
      const cached = catalogueCache.get(baseUrl);
      if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
        return cached.value;
      }
      const value = await must<CatalogueResponse>("/catalogue");
      catalogueCache.set(baseUrl, { at: Date.now(), value });
      return value;
    },
    edition: (author, work, edition, version) =>
      get(withVersion(editionBase(author, work, edition), version)),
    fullText: (author, work, edition, version) =>
      get(withVersion(`${editionBase(author, work, edition)}/full`, version)),
    section: (author, work, edition, path, version) =>
      get(withVersion(
        `${editionBase(author, work, edition)}/${path.map(segment).join("/")}`,
        version,
      )),
    sectionFullText: (author, work, edition, path, version) =>
      get(withVersion(
        `${editionBase(author, work, edition)}/${
          path.map(segment).join("/")
        }/full`,
        version,
      )),
    compare: (author, work, a, b) =>
      get(`${workBase(author, work)}/compare/${segment(a)}/${segment(b)}`),
    compareSection: (author, work, a, b, path, version) =>
      get(withVersion(
        `${workBase(author, work)}/compare/${segment(a)}/${segment(b)}/${
          path.map(segment).join("/")
        }`,
        version,
      )),
    search: (params) =>
      must(`/search${
        qs({
          q: params.q,
          match: params.match,
          caseSensitive: params.caseSensitive,
          resolved: params.resolved,
          version: params.version,
          author: params.author,
          work: params.work,
          edition: params.edition,
          editions: params.editions,
          page: params.page,
          perPage: params.perPage,
        })
      }`),
    frequency: (params) =>
      must(`/frequency${
        qs({
          q: params.q,
          groupBy: params.groupBy,
          match: params.match,
          caseSensitive: params.caseSensitive,
          version: params.version,
          author: params.author,
          work: params.work,
          edition: params.edition,
          editions: params.editions,
        })
      }`),
    concordance: (params) =>
      must(`/concordance${
        qs({
          q: params.q,
          window: params.window,
          sort: params.sort,
          match: params.match,
          caseSensitive: params.caseSensitive,
          version: params.version,
          author: params.author,
          work: params.work,
          edition: params.edition,
          editions: params.editions,
          page: params.page,
          perPage: params.perPage,
        })
      }`),
    keywords: (params) =>
      must(`/keywords${
        qs({
          author: params.author,
          work: params.work,
          edition: params.edition,
          editions: params.editions,
          by: params.by,
          version: params.version,
          min: params.min,
          limit: params.limit,
        })
      }`),
    collocations: (params) =>
      must(`/collocations${
        qs({
          q: params.q,
          by: params.by,
          match: params.match,
          window: params.window,
          min: params.min,
          limit: params.limit,
          author: params.author,
          work: params.work,
          edition: params.edition,
          editions: params.editions,
        })
      }`),
    similar: (params) =>
      must(`/similar${
        qs({
          author: params.author,
          work: params.work,
          edition: params.edition,
          path: params.path?.map(segment).join("/"),
          level: params.level,
          limit: params.limit,
        })
      }`),
    topics: (params) =>
      must(`/topics${qs({ terms: params.terms, works: params.works })}`),
    topicMix: (params) =>
      must(`/topics/mix${
        qs({
          author: params.author,
          work: params.work,
          edition: params.edition,
          path: params.path?.map(segment).join("/"),
          level: params.level,
          limit: params.limit,
        })
      }`),
  };
};
