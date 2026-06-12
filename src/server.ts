/**
 * The HTTP shell around the API builders in api.ts: routing, JSON
 * serialization, rate limiting, and errors. Kept as thin as possible.
 *
 * Routes (all GET):
 *   /                                          health/info
 *   /catalog                                   all works and editions
 *   /works/:work/editions/:edition             title blocks + section tree
 *   /works/:work/editions/:edition/full        whole edition with text
 *   /works/:work/editions/:edition/sections/*  one section + navigation
 *   /works/:work/compare/:a/:b                 aligned section lists
 *   /works/:work/compare/:a/:b/sections/*      block-level diff of a section
 *   /search?q=&work=&edition=&page=&perPage=   full-text search
 */

import type { Catalog } from "./lib/catalog.ts";
import { findEdition } from "./lib/catalog.ts";
import type { SearchIndex } from "./lib/search.ts";
import {
  catalogResponse,
  compareResponse,
  compareSectionResponse,
  editionResponse,
  fullTextResponse,
  searchResponse,
  sectionResponse,
} from "./api.ts";
import { clientKey, type RateLimiter } from "./ratelimit.ts";

export type Api = {
  catalog: Catalog;
  searchIndex: SearchIndex;
  limiter?: RateLimiter;
};

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=300",
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: HEADERS });

const notFound = (): Response => json({ error: "not found" }, 404);

const route = (api: Api, url: URL): Response => {
  const segments = url.pathname.split("/").map(decodeURIComponent)
    .filter((s) => s !== "").map((s) => s.toLowerCase());

  if (segments.length === 0) {
    return json({ service: "computer", works: api.catalog.works.length });
  }
  if (segments[0] === "catalog" && segments.length === 1) {
    return json(catalogResponse(api.catalog));
  }
  if (segments[0] === "search" && segments.length === 1) {
    const params = url.searchParams;
    return json(searchResponse(api.catalog, api.searchIndex, {
      q: params.get("q") ?? "",
      work: params.get("work") ?? undefined,
      edition: params.get("edition") ?? undefined,
      page: Number(params.get("page")) || undefined,
      perPage: Number(params.get("perPage")) || undefined,
    }));
  }

  if (segments[0] !== "works" || segments.length < 4) return notFound();
  const work = api.catalog.bySlug.get(segments[1]);
  if (work === undefined) return notFound();

  if (segments[2] === "editions") {
    const edition = findEdition(work, segments[3]);
    if (edition === undefined) return notFound();
    const rest = segments.slice(4);
    if (rest.length === 0) return json(editionResponse(work, edition));
    if (rest.length === 1 && rest[0] === "full") {
      return json(fullTextResponse(work, edition));
    }
    if (rest[0] === "sections" && rest.length > 1) {
      const section = sectionResponse(work, edition, rest.slice(1));
      return section === undefined ? notFound() : json(section);
    }
    return notFound();
  }

  if (segments[2] === "compare" && segments.length >= 5) {
    const [a, b, ...rest] = segments.slice(3);
    if (rest.length === 0) {
      const compared = compareResponse(work, a, b);
      return compared === undefined ? notFound() : json(compared);
    }
    if (rest[0] === "sections" && rest.length > 1) {
      const compared = compareSectionResponse(work, a, b, rest.slice(1));
      return compared === undefined ? notFound() : json(compared);
    }
    return notFound();
  }

  return notFound();
};

export const createHandler =
  (api: Api) => (req: Request, info?: Deno.ServeHandlerInfo): Response => {
    const remoteAddr = info === undefined || info.remoteAddr.transport !== "tcp"
      ? undefined
      : info.remoteAddr.hostname;
    if (api.limiter !== undefined) {
      if (!api.limiter.allow(clientKey(req, remoteAddr))) {
        return new Response(
          JSON.stringify({ error: "rate limit exceeded" }),
          {
            status: 429,
            headers: { ...HEADERS, "retry-after": "1" },
          },
        );
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: "method not allowed" }, 405);
    }
    try {
      return route(api, new URL(req.url));
    } catch (error) {
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
  };
