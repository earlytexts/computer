/**
 * The HTTP shell around the API builders in api.ts: routing, JSON
 * serialization, rate limiting, and errors. Kept as thin as possible.
 *
 * Routes (all GET):
 *   /                                                          health/info
 *   /catalog                                                   all authors, works, and editions
 *   /authors/:author/works/:work                               canonical edition: title blocks + section tree
 *   /authors/:author/works/:work/full                          canonical edition with text
 *   /authors/:author/works/:work/sections/*                    one canonical-edition section + navigation
 *   /authors/:author/works/:work/editions/:edition[/full|/sections/*]  a specific edition
 *   /authors/:author/works/:work/compare/:a/:b                 aligned section lists
 *   /authors/:author/works/:work/compare/:a/:b/sections/*      diff of a section (Markit)
 *   /search?q=&match=&caseSensitive=&version=&author=&work=&edition=&page=&perPage=  full-text search
 *   /frequency?q=&by=author|work|edition&match=&caseSensitive=&version=&author=&work=&edition=  term/phrase frequency
 *   /concordance?q=&context=&sort=position|left|right&match=&caseSensitive=&version=&author=&work=&edition=&page=&perPage=  keyword-in-context lines
 *
 * A request without `/editions/:edition` addresses the work's canonical
 * edition. Search with no `edition` is scoped to canonical editions;
 * `edition=all` searches every edition.
 *
 * Search matches the whole query as one phrase; it is tolerant by default
 * (match=form), tightened by match=spelling|exact and/or caseSensitive=1 (see
 * types.ts). Text
 * routes take ?version=edited|original|both (default edited); search and
 * compare take ?version=edited|original (default edited).
 */

import type { ServeArtefacts } from "./artefacts.ts";
import {
  type BlockReader,
  type BlockStore,
  createBlockStore,
  findAuthorEntry,
  findEditionEntry,
  findWorkEntry,
} from "./serve/store.ts";
import {
  catalogResponse,
  compareResponse,
  compareSectionResponse,
  concordanceResponse,
  editionResponse,
  frequencyResponse,
  fullTextResponse,
  searchResponse,
  sectionFullTextResponse,
  sectionResponse,
} from "./serve/api.ts";
import {
  clientKey,
  createRateLimiter,
  type RateLimiterOptions,
} from "./serve/ratelimit.ts";
import { createMcpHandler } from "./mcp.ts";
import type { Version } from "../types.ts";

export type Api = {
  artefacts: ServeArtefacts;
  /** Lazy block reader, rooted at the artefacts directory. */
  blocks: BlockReader;
  /** Per-client token bucket; omit to disable rate limiting. */
  rateLimit?: RateLimiterOptions;
};

/** ?version for text routes: edited (default), original, or both. */
const textVersion = (url: URL): Version =>
  url.searchParams.get("version") === "original"
    ? "original"
    : url.searchParams.get("version") === "both"
    ? "both"
    : "edited";

/** ?version for compare: edited (default) or original (no `both`). */
const compareVersion = (url: URL): Version =>
  url.searchParams.get("version") === "original" ? "original" : "edited";

/** A boolean query flag: "1" or "true" (case-insensitive) is on. */
const flag = (value: string | null): boolean =>
  value === "1" || value?.toLowerCase() === "true";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=300",
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: HEADERS });

const notFound = (): Response => json({ error: "not found" }, 404);

const route = async (
  api: Api,
  store: BlockStore,
  url: URL,
): Promise<Response> => {
  const { catalog } = api.artefacts;
  const segments = url.pathname.split("/").map(decodeURIComponent)
    .filter((s) => s !== "").map((s) => s.toLowerCase());

  if (segments.length === 0) {
    return json({
      service: "computer",
      authors: catalog.authors.length,
      works: catalog.authors.reduce((n, a) => n + a.works.length, 0),
    });
  }
  if (segments[0] === "catalog" && segments.length === 1) {
    return json(catalogResponse(catalog));
  }
  if (segments[0] === "search" && segments.length === 1) {
    const params = url.searchParams;
    return json(
      await searchResponse(store, api.artefacts, {
        q: params.get("q") ?? "",
        match: params.get("match") ?? undefined,
        caseSensitive: flag(params.get("caseSensitive")),
        version: params.get("version") ?? undefined,
        author: params.get("author") ?? undefined,
        work: params.get("work") ?? undefined,
        edition: params.get("edition") ?? undefined,
        page: Number(params.get("page")) || undefined,
        perPage: Number(params.get("perPage")) || undefined,
      }),
    );
  }
  if (segments[0] === "frequency" && segments.length === 1) {
    const params = url.searchParams;
    return json(
      frequencyResponse(api.artefacts, {
        q: params.get("q") ?? "",
        by: params.get("by") ?? undefined,
        match: params.get("match") ?? undefined,
        caseSensitive: flag(params.get("caseSensitive")),
        version: params.get("version") ?? undefined,
        author: params.get("author") ?? undefined,
        work: params.get("work") ?? undefined,
        edition: params.get("edition") ?? undefined,
      }),
    );
  }
  if (segments[0] === "concordance" && segments.length === 1) {
    const params = url.searchParams;
    return json(
      await concordanceResponse(store, api.artefacts, {
        q: params.get("q") ?? "",
        context: Number(params.get("context")) || undefined,
        sort: params.get("sort") ?? undefined,
        match: params.get("match") ?? undefined,
        caseSensitive: flag(params.get("caseSensitive")),
        version: params.get("version") ?? undefined,
        author: params.get("author") ?? undefined,
        work: params.get("work") ?? undefined,
        edition: params.get("edition") ?? undefined,
        page: Number(params.get("page")) || undefined,
        perPage: Number(params.get("perPage")) || undefined,
      }),
    );
  }

  if (
    segments[0] !== "authors" || segments[2] !== "works" || segments.length < 4
  ) return notFound();
  const author = findAuthorEntry(catalog, segments[1]);
  const work = author === undefined
    ? undefined
    : findWorkEntry(author, segments[3]);
  if (author === undefined || work === undefined) return notFound();

  if (segments[4] !== "compare") {
    // An explicit `/editions/:slug/...` names the edition; otherwise the path
    // addresses the work's canonical edition directly.
    const [edition, rest] = segments[4] === "editions"
      ? [findEditionEntry(work, segments[5]), segments.slice(6)] as const
      : [
        findEditionEntry(work, work.meta.canonicalSlug),
        segments.slice(4),
      ] as const;
    if (edition === undefined) return notFound();
    if (rest.length === 0) {
      return json(
        await editionResponse(store, author, work, edition, textVersion(url)),
      );
    }
    if (rest.length === 1 && rest[0] === "full") {
      return json(
        await fullTextResponse(store, author, work, edition, textVersion(url)),
      );
    }
    if (rest[0] === "sections" && rest.length > 1) {
      const sectionPath = rest.slice(1);
      // A trailing /full on a section path returns its full text (recursively).
      if (
        sectionPath.length > 1 &&
        sectionPath[sectionPath.length - 1] === "full"
      ) {
        const data = await sectionFullTextResponse(
          store,
          author,
          work,
          edition,
          sectionPath.slice(0, -1),
          textVersion(url),
        );
        return data === undefined ? notFound() : json(data);
      }
      const section = await sectionResponse(
        store,
        author,
        work,
        edition,
        sectionPath,
        textVersion(url),
      );
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
      const compared = await compareSectionResponse(
        store,
        author,
        work,
        a,
        b,
        rest.slice(1),
        compareVersion(url),
      );
      return compared === undefined ? notFound() : json(compared);
    }
    return notFound();
  }

  return notFound();
};

export const createHandler = (api: Api) => {
  // One block store (and its LRU) for the life of the handler.
  const store = createBlockStore(api.artefacts, api.blocks);
  // The MCP server shares the block store; it serves the corpus tools over
  // Streamable HTTP at /mcp (POST/GET/DELETE), alongside the REST routes.
  const mcp = createMcpHandler(api.artefacts, store);
  const limiter = api.rateLimit === undefined
    ? undefined
    : createRateLimiter(api.rateLimit);
  return async (
    req: Request,
    info?: Deno.ServeHandlerInfo,
  ): Promise<Response> => {
    const remoteAddr = info === undefined || info.remoteAddr.transport !== "tcp"
      ? undefined
      : info.remoteAddr.hostname;
    if (limiter !== undefined) {
      if (!limiter.allow(clientKey(req, remoteAddr))) {
        return new Response(
          JSON.stringify({ error: "rate limit exceeded" }),
          {
            status: 429,
            headers: { ...HEADERS, "retry-after": "1" },
          },
        );
      }
    }
    // MCP owns its own methods (POST/GET/DELETE), so it must come before the
    // GET-only guard the REST routes rely on.
    if (new URL(req.url).pathname === "/mcp") {
      const response = await mcp(req);
      response.headers.set("access-control-allow-origin", "*");
      return response;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: "method not allowed" }, 405);
    }
    try {
      return await route(api, store, new URL(req.url));
    } catch (error) {
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
  };
};
