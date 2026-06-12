/**
 * The HTTP shell around the API builders in api.ts: routing, JSON
 * serialization, rate limiting, and errors. Kept as thin as possible.
 *
 * Routes (all GET):
 *   /                                                          health/info
 *   /catalog                                                   all authors, works, and editions
 *   /authors/:author/works/:work/editions/:edition             title blocks + section tree
 *   /authors/:author/works/:work/editions/:edition/full        whole edition with text
 *   /authors/:author/works/:work/editions/:edition/sections/*  one section + navigation
 *   /authors/:author/works/:work/compare/:a/:b                 aligned section lists
 *   /authors/:author/works/:work/compare/:a/:b/sections/*      block-level diff of a section
 *   /search?q=&mode=&author=&work=&edition=&page=&perPage=     full-text search
 */

import type { Catalog } from "./lib/catalog.ts";
import { findEdition, findWork } from "./lib/catalog.ts";
import type { ServeArtefacts } from "./lib/artefacts.ts";
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
  artefacts: ServeArtefacts;
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

const route = async (api: Api, url: URL): Promise<Response> => {
  const segments = url.pathname.split("/").map(decodeURIComponent)
    .filter((s) => s !== "").map((s) => s.toLowerCase());

  if (segments.length === 0) {
    return json({
      service: "computer",
      authors: api.catalog.authors.length,
      works: api.catalog.authors.reduce((n, a) => n + a.works.length, 0),
    });
  }
  if (segments[0] === "catalog" && segments.length === 1) {
    return json(catalogResponse(api.catalog));
  }
  if (segments[0] === "search" && segments.length === 1) {
    const params = url.searchParams;
    return json(
      await searchResponse(api.artefacts, {
        q: params.get("q") ?? "",
        mode: params.get("mode") ?? undefined,
        author: params.get("author") ?? undefined,
        work: params.get("work") ?? undefined,
        edition: params.get("edition") ?? undefined,
        page: Number(params.get("page")) || undefined,
        perPage: Number(params.get("perPage")) || undefined,
      }),
    );
  }

  if (
    segments[0] !== "authors" || segments[2] !== "works" || segments.length < 6
  ) return notFound();
  const author = api.catalog.byAuthor.get(segments[1]);
  const work = author === undefined
    ? undefined
    : findWork(api.catalog, segments[1], segments[3]);
  if (author === undefined || work === undefined) return notFound();

  if (segments[4] === "editions") {
    const edition = findEdition(work, segments[5]);
    if (edition === undefined) return notFound();
    const rest = segments.slice(6);
    if (rest.length === 0) return json(editionResponse(author, work, edition));
    if (rest.length === 1 && rest[0] === "full") {
      return json(fullTextResponse(author, work, edition));
    }
    if (rest[0] === "sections" && rest.length > 1) {
      const section = sectionResponse(author, work, edition, rest.slice(1));
      return section === undefined ? notFound() : json(section);
    }
    return notFound();
  }

  if (segments[4] === "compare" && segments.length >= 7) {
    const [a, b, ...rest] = segments.slice(5);
    if (rest.length === 0) {
      const compared = compareResponse(author, work, a, b);
      return compared === undefined ? notFound() : json(compared);
    }
    if (rest[0] === "sections" && rest.length > 1) {
      const compared = compareSectionResponse(
        author,
        work,
        a,
        b,
        rest.slice(1),
      );
      return compared === undefined ? notFound() : json(compared);
    }
    return notFound();
  }

  return notFound();
};

export const createHandler =
  (api: Api) =>
  async (req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> => {
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
      return await route(api, new URL(req.url));
    } catch (error) {
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
  };
