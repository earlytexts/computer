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
 *   /search?q=&match=&caseSensitive=&version=&author=&work=&editions=canonical|all&edition=&page=&perPage=  full-text search
 *   /frequency?q=&groupBy=author|work|edition&match=&caseSensitive=&version=&author=&work=&editions=canonical|all&edition=  term/phrase frequency
 *   /concordance?q=&window=&sort=position|left|right&match=&caseSensitive=&version=&author=&work=&editions=canonical|all&edition=&page=&perPage=  keyword-in-context lines
 *   /keywords?author=&work=&editions=canonical|all&edition=&by=lemma|form|surface&version=&min=&limit=  keyness: a subcorpus's distinctive words
 *   /collocations?q=&by=lemma|form|surface&match=&window=&min=&limit=&author=&work=&editions=canonical|all&edition=  words that occur near a node word
 *   /similar?author=&work=&edition=&path=&level=section|edition|work&limit=  corpus items most lexically like a target
 *   /topics?terms=&works=                                       the corpus topic model: each topic's top terms and prominent works
 *   /topics/mix?author=&work=&edition=&path=&level=section|edition|work&limit=  a target's topic mix ("what this work is about")
 *
 * After the work, a year-shaped segment (four digits, optional letter, e.g.
 * `1772` or `1742a`) names a specific edition; without one the path addresses
 * the work's canonical edition. Everything else is a section path. On the
 * universe-filter routes (search, frequency, concordance, keywords,
 * collocations) the edition scope is two orthogonal params: `editions`
 * (canonical, the default, or `all`) chooses the universe across works, while
 * `edition=<year>` names one specific printing and is only valid with `work`
 * (the two cannot be combined). See scope.ts. The single-target routes (similar,
 * topics/mix) keep `edition` as the target printing.
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
import { type EditionScopeParams, scopeError } from "./scope.ts";
import {
  boolParam,
  enumParam,
  GROUP_BYS,
  intParam,
  KEY_MODES,
  LEVELS,
  MATCH_LEVELS,
  ParamError,
  rejectUnknownParams,
  SEARCH_VERSIONS,
  SORTS,
  TEXT_VERSIONS,
} from "./params.ts";
import type { Computer, Version } from "./types.ts";

export type Api = {
  /** The computer the routes call; the same interface MCP and the client use. */
  computer: Computer;
  /** Per-client token bucket; omit to disable rate limiting. */
  rateLimit?: RateLimiterOptions;
  /** Clock for the rate limiter; defaults to `Date.now` (injected in tests). */
  now?: () => number;
};

/** ?version for text routes: edited (default), original, or both. */
const textVersion = (p: URLSearchParams): Version =>
  enumParam("version", p.get("version"), TEXT_VERSIONS) ?? "edited";

/** ?version for search/compare: edited (default) or original (no `both`). */
const editedOrOriginal = (p: URLSearchParams): "edited" | "original" =>
  enumParam("version", p.get("version"), SEARCH_VERSIONS) ?? "edited";

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

const badRequest = (message: string): Response => json({ error: message }, 400);

/** The shared edition-scope params (work, edition, editions) from the query. */
const scopeOf = (p: URLSearchParams): EditionScopeParams => ({
  work: p.get("work") ?? undefined,
  edition: p.get("edition") ?? undefined,
  editions: p.get("editions") ?? undefined,
});

/** Validate the edition-scope params together; throws a `ParamError` on a clash. */
const checkScope = (scope: EditionScopeParams): void => {
  const err = scopeError(scope);
  if (err !== undefined) throw new ParamError(err);
};

/* The exact query parameters each route accepts; anything else is a 400. The
 * three edition-scope knobs (work, edition, editions) recur across the universe
 * routes (see scope.ts). */
const SCOPE = ["work", "edition", "editions"] as const;
const SEARCH_PARAMS = [
  "q",
  "match",
  "caseSensitive",
  "version",
  "author",
  "page",
  "perPage",
  ...SCOPE,
] as const;
const FREQUENCY_PARAMS = [
  "q",
  "groupBy",
  "match",
  "caseSensitive",
  "version",
  "author",
  ...SCOPE,
] as const;
const CONCORDANCE_PARAMS = [
  "q",
  "window",
  "sort",
  "match",
  "caseSensitive",
  "version",
  "author",
  "page",
  "perPage",
  ...SCOPE,
] as const;
const KEYWORDS_PARAMS = [
  "author",
  "by",
  "version",
  "min",
  "limit",
  ...SCOPE,
] as const;
const COLLOCATIONS_PARAMS = [
  "q",
  "by",
  "match",
  "window",
  "min",
  "limit",
  "author",
  ...SCOPE,
] as const;
const SIMILAR_PARAMS = [
  "author",
  "work",
  "edition",
  "path",
  "level",
  "limit",
] as const;
const TOPICS_PARAMS = ["terms", "works"] as const;
const TOPIC_MIX_PARAMS = SIMILAR_PARAMS;
/** The reading and compare routes take only ?version. */
const VERSION_ONLY = ["version"] as const;

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
    rejectUnknownParams(p, SEARCH_PARAMS);
    const scope = scopeOf(p);
    checkScope(scope);
    return json(
      await computer.search({
        q: p.get("q") ?? "",
        match: enumParam("match", p.get("match"), MATCH_LEVELS),
        caseSensitive: boolParam("caseSensitive", p.get("caseSensitive")),
        version: editedOrOriginal(p),
        author: p.get("author") ?? undefined,
        work: scope.work,
        edition: scope.edition,
        editions: scope.editions as "canonical" | "all" | undefined,
        page: intParam("page", p.get("page")),
        perPage: intParam("perPage", p.get("perPage")),
      }),
    );
  }
  if (segments[0] === "frequency" && segments.length === 1) {
    rejectUnknownParams(p, FREQUENCY_PARAMS);
    const scope = scopeOf(p);
    checkScope(scope);
    return json(
      await computer.frequency({
        q: p.get("q") ?? "",
        groupBy: enumParam("groupBy", p.get("groupBy"), GROUP_BYS),
        match: enumParam("match", p.get("match"), MATCH_LEVELS),
        caseSensitive: boolParam("caseSensitive", p.get("caseSensitive")),
        version: editedOrOriginal(p),
        author: p.get("author") ?? undefined,
        work: scope.work,
        edition: scope.edition,
        editions: scope.editions as "canonical" | "all" | undefined,
      }),
    );
  }
  if (segments[0] === "concordance" && segments.length === 1) {
    rejectUnknownParams(p, CONCORDANCE_PARAMS);
    const scope = scopeOf(p);
    checkScope(scope);
    return json(
      await computer.concordance({
        q: p.get("q") ?? "",
        window: intParam("window", p.get("window")),
        sort: enumParam("sort", p.get("sort"), SORTS),
        match: enumParam("match", p.get("match"), MATCH_LEVELS),
        caseSensitive: boolParam("caseSensitive", p.get("caseSensitive")),
        version: editedOrOriginal(p),
        author: p.get("author") ?? undefined,
        work: scope.work,
        edition: scope.edition,
        editions: scope.editions as "canonical" | "all" | undefined,
        page: intParam("page", p.get("page")),
        perPage: intParam("perPage", p.get("perPage")),
      }),
    );
  }

  if (segments[0] === "keywords" && segments.length === 1) {
    rejectUnknownParams(p, KEYWORDS_PARAMS);
    const scope = scopeOf(p);
    checkScope(scope);
    return json(
      await computer.keywords({
        author: p.get("author") ?? undefined,
        work: scope.work,
        edition: scope.edition,
        editions: scope.editions as "canonical" | "all" | undefined,
        by: enumParam("by", p.get("by"), KEY_MODES),
        version: editedOrOriginal(p),
        min: intParam("min", p.get("min")),
        limit: intParam("limit", p.get("limit")),
      }),
    );
  }

  if (segments[0] === "collocations" && segments.length === 1) {
    rejectUnknownParams(p, COLLOCATIONS_PARAMS);
    const scope = scopeOf(p);
    checkScope(scope);
    return json(
      await computer.collocations({
        q: p.get("q") ?? "",
        by: enumParam("by", p.get("by"), KEY_MODES),
        match: enumParam("match", p.get("match"), MATCH_LEVELS),
        window: intParam("window", p.get("window")),
        min: intParam("min", p.get("min")),
        limit: intParam("limit", p.get("limit")),
        author: p.get("author") ?? undefined,
        work: scope.work,
        edition: scope.edition,
        editions: scope.editions as "canonical" | "all" | undefined,
      }),
    );
  }

  if (segments[0] === "similar" && segments.length === 1) {
    rejectUnknownParams(p, SIMILAR_PARAMS);
    const path = p.get("path");
    return json(
      await computer.similar({
        author: p.get("author") ?? undefined,
        work: p.get("work") ?? undefined,
        edition: p.get("edition") ?? undefined,
        path: path === null
          ? undefined
          : path.split("/").filter((s) => s !== ""),
        level: enumParam("level", p.get("level"), LEVELS),
        limit: intParam("limit", p.get("limit")),
      }),
    );
  }

  if (segments[0] === "topics") {
    if (segments.length === 1) {
      rejectUnknownParams(p, TOPICS_PARAMS);
      return json(
        await computer.topics({
          terms: intParam("terms", p.get("terms")),
          works: intParam("works", p.get("works")),
        }),
      );
    }
    if (segments[1] === "mix" && segments.length === 2) {
      rejectUnknownParams(p, TOPIC_MIX_PARAMS);
      const path = p.get("path");
      return json(
        await computer.topicMix({
          author: p.get("author") ?? undefined,
          work: p.get("work") ?? undefined,
          edition: p.get("edition") ?? undefined,
          path: path === null
            ? undefined
            : path.split("/").filter((s) => s !== ""),
          level: enumParam("level", p.get("level"), LEVELS),
          limit: intParam("limit", p.get("limit")),
        }),
      );
    }
    return notFound();
  }

  if (segments[0] !== "authors" || segments.length < 3) return notFound();
  // The reading and compare routes carry their target in the path; ?version is
  // the only query parameter either accepts.
  rejectUnknownParams(p, VERSION_ONLY);
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
        editedOrOriginal(p),
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
      await computer.edition(author, work, edition, textVersion(p)),
    );
  }
  if (rest.length === 1 && rest[0] === "full") {
    return found(
      await computer.fullText(author, work, edition, textVersion(p)),
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
        textVersion(p),
      ),
    );
  }
  return found(
    await computer.section(author, work, edition, rest, textVersion(p)),
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
      // A malformed parameter is the client's fault (400); anything else is ours.
      if (error instanceof ParamError) return badRequest(error.message);
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
  };
};
