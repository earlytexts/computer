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
 * The catalog rarely changes (only on a computer redeploy), so it is cached per
 * base URL for a minute to spare one round-trip per page view.
 */

import type { CatalogResponse, Computer, Version } from "./types.ts";

const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map<string, { at: number; value: CatalogResponse }>();

const segment = (s: string): string => encodeURIComponent(s);

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
    catalog: async () => {
      const cached = catalogCache.get(baseUrl);
      if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
        return cached.value;
      }
      const value = await must<CatalogResponse>("/catalog");
      catalogCache.set(baseUrl, { at: Date.now(), value });
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
    search: (params) => {
      const query = new URLSearchParams({ q: params.q });
      if (params.match !== undefined) query.set("match", params.match);
      if (params.caseSensitive) query.set("caseSensitive", "1");
      if (params.version !== undefined) query.set("version", params.version);
      if (params.author !== undefined) query.set("author", params.author);
      if (params.work !== undefined) query.set("work", params.work);
      if (params.edition !== undefined) query.set("edition", params.edition);
      if (params.page !== undefined) query.set("page", String(params.page));
      if (params.perPage !== undefined) {
        query.set("perPage", String(params.perPage));
      }
      return must(`/search?${query}`);
    },
    frequency: (params) => {
      const query = new URLSearchParams({ q: params.q });
      if (params.by !== undefined) query.set("by", params.by);
      if (params.match !== undefined) query.set("match", params.match);
      if (params.caseSensitive) query.set("caseSensitive", "1");
      if (params.version !== undefined) query.set("version", params.version);
      if (params.author !== undefined) query.set("author", params.author);
      if (params.work !== undefined) query.set("work", params.work);
      if (params.edition !== undefined) query.set("edition", params.edition);
      return must(`/frequency?${query}`);
    },
    concordance: (params) => {
      const query = new URLSearchParams({ q: params.q });
      if (params.context !== undefined) {
        query.set("context", String(params.context));
      }
      if (params.sort !== undefined) query.set("sort", params.sort);
      if (params.match !== undefined) query.set("match", params.match);
      if (params.caseSensitive) query.set("caseSensitive", "1");
      if (params.version !== undefined) query.set("version", params.version);
      if (params.author !== undefined) query.set("author", params.author);
      if (params.work !== undefined) query.set("work", params.work);
      if (params.edition !== undefined) query.set("edition", params.edition);
      if (params.page !== undefined) query.set("page", String(params.page));
      if (params.perPage !== undefined) {
        query.set("perPage", String(params.perPage));
      }
      return must(`/concordance?${query}`);
    },
    keywords: (params) => {
      const query = new URLSearchParams();
      if (params.author !== undefined) query.set("author", params.author);
      if (params.work !== undefined) query.set("work", params.work);
      if (params.edition !== undefined) query.set("edition", params.edition);
      if (params.by !== undefined) query.set("by", params.by);
      if (params.version !== undefined) query.set("version", params.version);
      if (params.min !== undefined) query.set("min", String(params.min));
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      return must(`/keywords?${query}`);
    },
    collocations: (params) => {
      const query = new URLSearchParams({ q: params.q });
      if (params.by !== undefined) query.set("by", params.by);
      if (params.match !== undefined) query.set("match", params.match);
      if (params.window !== undefined) {
        query.set("window", String(params.window));
      }
      if (params.min !== undefined) query.set("min", String(params.min));
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      if (params.author !== undefined) query.set("author", params.author);
      if (params.work !== undefined) query.set("work", params.work);
      if (params.edition !== undefined) query.set("edition", params.edition);
      return must(`/collocations?${query}`);
    },
    similar: (params) => {
      const query = new URLSearchParams();
      if (params.author !== undefined) query.set("author", params.author);
      if (params.work !== undefined) query.set("work", params.work);
      if (params.edition !== undefined) query.set("edition", params.edition);
      if (params.path !== undefined) {
        query.set("path", params.path.map(segment).join("/"));
      }
      if (params.level !== undefined) query.set("level", params.level);
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      return must(`/similar?${query}`);
    },
    topics: (params) => {
      const query = new URLSearchParams();
      if (params.terms !== undefined) query.set("terms", String(params.terms));
      if (params.works !== undefined) query.set("works", String(params.works));
      const suffix = query.toString();
      return must(suffix === "" ? "/topics" : `/topics?${suffix}`);
    },
    topicMix: (params) => {
      const query = new URLSearchParams();
      if (params.author !== undefined) query.set("author", params.author);
      if (params.work !== undefined) query.set("work", params.work);
      if (params.edition !== undefined) query.set("edition", params.edition);
      if (params.path !== undefined) {
        query.set("path", params.path.map(segment).join("/"));
      }
      if (params.level !== undefined) query.set("level", params.level);
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      return must(`/topics/mix?${query}`);
    },
  };
};
