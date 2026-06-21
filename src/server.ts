/**
 * The HTTP shell over a `Computer`: it parses each request into a `Computer`
 * method call and serializes the result as JSON, plus routing, rate limiting,
 * and errors. It holds no corpus logic of its own — slug resolution, the
 * canonical-edition default, scoping, and pagination all live in the `Computer`
 * it is handed (the same interface the MCP server and the HTTP client use).
 *
 * Routes (all GET):
 *   /                                                          health/info
 *   /catalog                                                   all authors, works, and editions
 *   /authors/:author/:work                                     canonical edition: title blocks + section tree
 *   /authors/:author/:work/full                                canonical edition with text
 *   /authors/:author/:work/*                                   one canonical-edition section + navigation
 *   /authors/:author/:work/:edition[/full|/*]                  a specific edition (its index, full text, or a section)
 *   /authors/:author/:work/compare/:a/:b                       aligned section lists
 *   /authors/:author/:work/compare/:a/:b/*                     diff of a section (Markit)
 *   /search?q=&match=&caseSensitive=&version=&author=&work=&edition=&page=&perPage=  full-text search
 *   /frequency?q=&by=author|work|edition&match=&caseSensitive=&version=&author=&work=&edition=  term/phrase frequency
 *   /concordance?q=&context=&sort=position|left|right&match=&caseSensitive=&version=&author=&work=&edition=&page=&perPage=  keyword-in-context lines
 *   /keywords?author=&work=&edition=&by=lemma|form|surface&version=&min=&limit=  keyness: a subcorpus's distinctive words
 *   /collocations?q=&by=lemma|form|surface&match=&window=&min=&limit=&author=&work=&edition=  words that occur near a node word
 *   /similar?author=&work=&edition=&path=&level=section|edition|work&limit=  corpus items most lexically like a target
 *   /topics?terms=&works=                                       the corpus topic model: each topic's top terms and prominent works
 *   /topics/mix?author=&work=&edition=&path=&level=section|edition|work&limit=  a target's topic mix ("what this work is about")
 *
 * After the work, a year-shaped segment (four digits, optional letter, e.g.
 * `1772` or `1742a`) names a specific edition; without one the path addresses
 * the work's canonical edition. Everything else is a section path. Search with
 * no `edition` is scoped to canonical editions; `edition=all` searches every
 * edition.
 *
 * Search matches the whole query as one phrase; it is tolerant by default
 * (match=form), tightened by match=spelling|exact and/or caseSensitive=1 (see
 * types.ts). Text routes take ?version=edited|original|both (default edited);
 * search and compare take ?version=edited|original (default edited).
 */

import {
  clientKey,
  createRateLimiter,
  type RateLimiterOptions,
} from "./ratelimit.ts";
import { createMcpHandler } from "./mcp.ts";
import type {
  Computer,
  KeyMode,
  MatchLevel,
  SimilarLevel,
  TopicLevel,
  Version,
} from "./types.ts";

export type Api = {
  /** The computer the routes call; the same interface MCP and the client use. */
  computer: Computer;
  /** Per-client token bucket; omit to disable rate limiting. */
  rateLimit?: RateLimiterOptions;
  /** Clock for the rate limiter; defaults to `Date.now` (injected in tests). */
  now?: () => number;
};

/** ?version for text routes: edited (default), original, or both. */
const textVersion = (url: URL): Version =>
  url.searchParams.get("version") === "original"
    ? "original"
    : url.searchParams.get("version") === "both"
    ? "both"
    : "edited";

/** ?version for search/compare: edited (default) or original (no `both`). */
const editedOrOriginal = (url: URL): "edited" | "original" =>
  url.searchParams.get("version") === "original" ? "original" : "edited";

/** A boolean query flag: "1" or "true" (case-insensitive) is on. */
const flag = (value: string | null): boolean =>
  value === "1" || value?.toLowerCase() === "true";

/**
 * A year-shaped path segment names an edition (four digits, optional printing
 * letter: `1772`, `1742a`). No section slug ever takes this shape — section
 * slugs are the last dotted segment of a section id (`Hume.THN.1.2` → `2`), so
 * a bare year cannot occur — which is what lets one segment carry either.
 */
const EDITION_RE = /^\d{4}[a-z]?$/;

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=300",
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: HEADERS });

const notFound = (): Response => json({ error: "not found" }, 404);

/** Serialize a `Computer` read result: 404 when it resolved nothing. */
const found = (value: unknown): Response =>
  value === undefined ? notFound() : json(value);

const route = async (computer: Computer, url: URL): Promise<Response> => {
  const segments = url.pathname.split("/").map(decodeURIComponent)
    .filter((s) => s !== "").map((s) => s.toLowerCase());
  const p = url.searchParams;

  if (segments.length === 0) {
    const catalog = await computer.catalog();
    return json({
      service: "computer",
      authors: catalog.authors.length,
      works: catalog.authors.reduce((n, a) => n + a.works.length, 0),
    });
  }
  if (segments[0] === "catalog" && segments.length === 1) {
    return json(await computer.catalog());
  }
  if (segments[0] === "search" && segments.length === 1) {
    return json(
      await computer.search({
        q: p.get("q") ?? "",
        match: (p.get("match") ?? undefined) as MatchLevel | undefined,
        caseSensitive: flag(p.get("caseSensitive")),
        version: editedOrOriginal(url),
        author: p.get("author") ?? undefined,
        work: p.get("work") ?? undefined,
        edition: p.get("edition") ?? undefined,
        page: Number(p.get("page")) || undefined,
        perPage: Number(p.get("perPage")) || undefined,
      }),
    );
  }
  if (segments[0] === "frequency" && segments.length === 1) {
    return json(
      await computer.frequency({
        q: p.get("q") ?? "",
        by: (p.get("by") ?? undefined) as
          | "author"
          | "work"
          | "edition"
          | undefined,
        match: (p.get("match") ?? undefined) as MatchLevel | undefined,
        caseSensitive: flag(p.get("caseSensitive")),
        version: editedOrOriginal(url),
        author: p.get("author") ?? undefined,
        work: p.get("work") ?? undefined,
        edition: p.get("edition") ?? undefined,
      }),
    );
  }
  if (segments[0] === "concordance" && segments.length === 1) {
    return json(
      await computer.concordance({
        q: p.get("q") ?? "",
        context: Number(p.get("context")) || undefined,
        sort: (p.get("sort") ?? undefined) as
          | "position"
          | "left"
          | "right"
          | undefined,
        match: (p.get("match") ?? undefined) as MatchLevel | undefined,
        caseSensitive: flag(p.get("caseSensitive")),
        version: editedOrOriginal(url),
        author: p.get("author") ?? undefined,
        work: p.get("work") ?? undefined,
        edition: p.get("edition") ?? undefined,
        page: Number(p.get("page")) || undefined,
        perPage: Number(p.get("perPage")) || undefined,
      }),
    );
  }

  if (segments[0] === "keywords" && segments.length === 1) {
    return json(
      await computer.keywords({
        author: p.get("author") ?? undefined,
        work: p.get("work") ?? undefined,
        edition: p.get("edition") ?? undefined,
        by: (p.get("by") ?? undefined) as KeyMode | undefined,
        version: editedOrOriginal(url),
        min: Number(p.get("min")) || undefined,
        limit: Number(p.get("limit")) || undefined,
      }),
    );
  }

  if (segments[0] === "collocations" && segments.length === 1) {
    return json(
      await computer.collocations({
        q: p.get("q") ?? "",
        by: (p.get("by") ?? undefined) as KeyMode | undefined,
        match: (p.get("match") ?? undefined) as MatchLevel | undefined,
        window: Number(p.get("window")) || undefined,
        min: Number(p.get("min")) || undefined,
        limit: Number(p.get("limit")) || undefined,
        author: p.get("author") ?? undefined,
        work: p.get("work") ?? undefined,
        edition: p.get("edition") ?? undefined,
      }),
    );
  }

  if (segments[0] === "similar" && segments.length === 1) {
    const path = p.get("path");
    return json(
      await computer.similar({
        author: p.get("author") ?? undefined,
        work: p.get("work") ?? undefined,
        edition: p.get("edition") ?? undefined,
        path: path === null
          ? undefined
          : path.split("/").filter((s) => s !== ""),
        level: (p.get("level") ?? undefined) as SimilarLevel | undefined,
        limit: Number(p.get("limit")) || undefined,
      }),
    );
  }

  if (segments[0] === "topics") {
    if (segments.length === 1) {
      return json(
        await computer.topics({
          terms: Number(p.get("terms")) || undefined,
          works: Number(p.get("works")) || undefined,
        }),
      );
    }
    if (segments[1] === "mix" && segments.length === 2) {
      const path = p.get("path");
      return json(
        await computer.topicMix({
          author: p.get("author") ?? undefined,
          work: p.get("work") ?? undefined,
          edition: p.get("edition") ?? undefined,
          path: path === null
            ? undefined
            : path.split("/").filter((s) => s !== ""),
          level: (p.get("level") ?? undefined) as TopicLevel | undefined,
          limit: Number(p.get("limit")) || undefined,
        }),
      );
    }
    return notFound();
  }

  if (segments[0] !== "authors" || segments.length < 3) return notFound();
  const author = segments[1];
  const work = segments[2];
  let rest = segments.slice(3);

  // Comparing two editions of the work: /compare/:a/:b[/:section...]. Any
  // segments past the two edition slugs are the section path being diffed.
  if (rest[0] === "compare") {
    if (rest.length < 3) return notFound();
    const [, a, b, ...path] = rest;
    if (path.length === 0) {
      return found(await computer.compare(author, work, a, b));
    }
    return found(
      await computer.compareSection(
        author,
        work,
        a,
        b,
        path,
        editedOrOriginal(url),
      ),
    );
  }

  // A leading year-shaped segment names the edition; otherwise the path
  // addresses the work's canonical edition (resolved by the computer).
  let edition: string | undefined;
  if (rest[0] !== undefined && EDITION_RE.test(rest[0])) {
    edition = rest[0];
    rest = rest.slice(1);
  }

  if (rest.length === 0) {
    return found(
      await computer.edition(author, work, edition, textVersion(url)),
    );
  }
  if (rest.length === 1 && rest[0] === "full") {
    return found(
      await computer.fullText(author, work, edition, textVersion(url)),
    );
  }
  // A trailing /full on a section path returns its full text (recursively);
  // the bare-/full work case above has already been handled.
  if (rest[rest.length - 1] === "full") {
    return found(
      await computer.sectionFullText(
        author,
        work,
        edition,
        rest.slice(0, -1),
        textVersion(url),
      ),
    );
  }
  return found(
    await computer.section(author, work, edition, rest, textVersion(url)),
  );
};

export const createHandler = (api: Api) => {
  // The MCP server is mounted on the same computer, served over Streamable HTTP
  // at /mcp (POST/GET/DELETE), alongside the REST routes.
  const mcp = createMcpHandler(api.computer);
  const limiter = api.rateLimit === undefined
    ? undefined
    : createRateLimiter(api.rateLimit);
  const now = api.now ?? Date.now;
  return async (
    req: Request,
    info?: Deno.ServeHandlerInfo,
  ): Promise<Response> => {
    const remoteAddr = info === undefined || info.remoteAddr.transport !== "tcp"
      ? undefined
      : info.remoteAddr.hostname;
    if (limiter !== undefined) {
      if (!limiter.allow(clientKey(req, remoteAddr), now())) {
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
      return await route(api.computer, new URL(req.url));
    } catch (error) {
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
  };
};
