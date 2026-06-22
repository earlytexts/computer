/**
 * The HTTP wiring: createHandler over a `Computer`. These tests own only what
 * the HTTP shell adds — routing, query parsing, status codes, headers, the
 * rate limiter, and the /mcp mount. The corpus behaviour (scoping, pagination,
 * grouping, version, diffs) is pinned through `Computer` in tests/core; here a
 * query like match=exact is used only to prove the parameter is wired through.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Api, createHandler } from "../../src/server.ts";
import { testComputer } from "../helpers.ts";
import type {
  CollocationsResponse,
  KeywordsResponse,
  SearchResponse,
  SimilarResponse,
  TopicMixResponse,
  TopicsResponse,
} from "../../src/types.ts";

/** A handler over the test computer, with optional rate-limit/clock. */
const handler = async (extra?: Partial<Api>) => {
  const computer = await testComputer();
  return createHandler({ computer, ...extra });
};

const request = async (path: string, method = "GET"): Promise<Response> =>
  (await handler())(new Request(`http://localhost${path}`, { method }));

const getJson = async <T>(path: string): Promise<T> => {
  const response = await request(path);
  assertEquals(response.status, 200, `expected 200 for ${path}`);
  return await response.json() as T;
};

Deno.test("the root reports service health", async () => {
  const info = await getJson<
    { service: string; authors: number; works: number }
  >(
    "/",
  );
  assertEquals(info.service, "computer");
  assertEquals(info.authors, 2);
  assertEquals(info.works, 4);
});

Deno.test("responses are JSON, CORS-open, and cached", async () => {
  const response = await request("/catalog");
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(response.headers.get("cache-control"), "public, max-age=300");
  await response.body?.cancel();
});

Deno.test("?format=text returns the rendered plain text the MCP tools serve", async () => {
  // A search hit, rendered: highlighted phrase and a plain-text content type.
  const response = await request(
    "/search?q=liberty of the press&format=text",
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-type"),
    "text/plain; charset=utf-8",
  );
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.text();
  assertStringIncludes(body, "«liberty of the press»");

  // A reading route renders too (the canonical edition's header).
  const edition = await request("/authors/test/tw?format=text");
  assertStringIncludes(await edition.text(), 'edition "1760"');

  // The catalog's text rendering lists the authors (as list_authors does).
  const catalog = await request("/catalog?format=text");
  assertStringIncludes(await catalog.text(), "test —");
});

Deno.test("?format=text on a missing resource is a plain-text 404", async () => {
  const response = await request("/authors/test/tw/99?format=text");
  assertEquals(response.status, 404);
  assertEquals(
    response.headers.get("content-type"),
    "text/plain; charset=utf-8",
  );
  assertEquals(await response.text(), "not found");
});

Deno.test("?format defaults to json and rejects any other value", async () => {
  // The default is unchanged JSON.
  const json = await request("/catalog");
  assertEquals(
    json.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  await json.body?.cancel();
  // format=json is explicit JSON.
  const explicit = await request("/search?q=virtue&format=json");
  assertEquals(
    explicit.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  await explicit.body?.cancel();
  // Anything off the list is a 400 naming the param, like every other enum.
  const bad = await request("/search?q=virtue&format=yaml");
  assertEquals(bad.status, 400);
  assertStringIncludes((await bad.json()).error, "format");
});

Deno.test("search query parameters are parsed and wired through", async () => {
  // match + edition scope reach the computer
  const exact = await getJson<SearchResponse>(
    "/search?q=encrease&match=exact&editions=all",
  );
  assertEquals(exact.match, "exact");
  assertEquals(exact.total, 1);
  assertEquals(exact.results[0].edition, "1750");
  // version reaches the computer
  assertEquals((await getJson<SearchResponse>("/search?q=corrcted")).total, 0);
  assertEquals(
    (await getJson<SearchResponse>("/search?q=corrcted&version=original"))
      .total,
    1,
  );
  // page + perPage are parsed
  const paged = await getJson<SearchResponse>(
    "/search?q=paragraph&editions=all&perPage=1&page=2",
  );
  assertEquals(paged.page, 2);
  assertEquals(paged.results.length, 1);
  assert(paged.pages > 1);
});

Deno.test("incoherent edition scope is a 400 on the universe routes", async () => {
  // A bare year with no work, and the two scope params combined, are rejected.
  for (
    const path of [
      "/search?q=virtue&edition=1751",
      "/frequency?q=virtue&edition=1751",
      "/concordance?q=virtue&edition=1751",
      "/keywords?author=test&edition=1751&editions=all",
      "/collocations?q=liberty&author=test&work=tw&edition=1760&editions=all",
    ]
  ) {
    const response = await request(path);
    assertEquals(response.status, 400, path);
    const body = await response.json() as { error: string };
    assert(body.error.length > 0, path);
  }
  // The coherent forms still resolve.
  assertEquals(
    (await request("/search?q=virtue&work=tw&author=test&edition=1760")).status,
    200,
  );
  assertEquals((await request("/search?q=virtue&editions=all")).status, 200);
});

Deno.test("malformed parameter values are a 400, not a silent default", async () => {
  // Each case names a param whose value the route used to coerce to a default.
  const cases: [string, string][] = [
    ["/search?q=virtue&match=fuzzy", "match"], // enum off the list
    ["/search?q=virtue&version=modern", "version"], // bad version
    ["/search?q=virtue&caseSensitive=yes", "caseSensitive"], // non-truth word
    ["/search?q=virtue&page=abc", "page"], // non-numeric
    ["/search?q=virtue&page=0", "page"], // below the floor
    ["/search?q=virtue&perPage=-5", "perPage"], // negative
    ["/search?q=virtue&perPage=1.5", "perPage"], // fractional
    ["/frequency?q=virtue&groupBy=year", "groupBy"], // bad enum
    ["/concordance?q=virtue&sort=middle", "sort"], // bad enum
    ["/keywords?author=test&by=stem", "by"], // bad enum
    ["/similar?author=test&work=tw&level=chapter", "level"], // bad enum
    ["/authors/test/tw?version=garbage", "version"], // bad version on a text route
  ];
  for (const [path, param] of cases) {
    const response = await request(path);
    assertEquals(response.status, 400, path);
    const body = await response.json() as { error: string };
    assertStringIncludes(body.error, param);
  }
});

Deno.test("an over-max count is clamped, not rejected", async () => {
  // perPage above the cap is a well-defined behaviour the interface keeps.
  const response = await request("/search?q=virtue&perPage=99999");
  assertEquals(response.status, 200);
  await response.body?.cancel();
});

Deno.test("an unknown query parameter is a 400 (a typo is not silently ignored)", async () => {
  for (
    const path of [
      "/search?q=virtue&cassSensitive=1", // misspelled caseSensitive
      "/keywords?author=test&limet=5", // misspelled limit
      "/authors/test/tw?versoin=original", // misspelled version on a text route
    ]
  ) {
    const response = await request(path);
    assertEquals(response.status, 400, path);
    const body = await response.json() as { error: string };
    assertStringIncludes(body.error, "unknown query parameter");
  }
  // A known parameter on the same routes still resolves.
  assertEquals((await request("/search?q=virtue&caseSensitive=1")).status, 200);
});

Deno.test("keywords and collocations echo the resolved editions universe", async () => {
  const canonical = await getJson<KeywordsResponse>(
    "/keywords?author=test&work=tw&min=1",
  );
  assertEquals(canonical.editions, "canonical");
  assertEquals(canonical.edition, null);
  const all = await getJson<CollocationsResponse>(
    "/collocations?q=liberty&editions=all&min=1",
  );
  assertEquals(all.editions, "all");
  assertEquals(all.edition, null);
});

Deno.test("keywords query parameters are parsed and wired through", async () => {
  const response = await getJson<KeywordsResponse>(
    "/keywords?author=test&work=tw&by=exact&min=1&limit=5",
  );
  assertEquals(response.by, "exact");
  assertEquals(response.author, "test");
  assertEquals(response.work, "tw");
  assert(response.results.length <= 5);
  assert(response.results.some((r) => r.term === "liberty"));
});

Deno.test("collocations query parameters are parsed and wired through", async () => {
  const response = await getJson<CollocationsResponse>(
    "/collocations?q=liberty&author=test&work=tw&by=exact&window=3&min=1&limit=5",
  );
  assertEquals(response.q, "liberty");
  assertEquals(response.by, "exact");
  assertEquals(response.match, "form");
  assertEquals(response.window, 3);
  assertEquals(response.author, "test");
  assertEquals(response.work, "tw");
  assert(response.nodeCount >= 2);
  assert(response.results.length > 0);
  assert(response.results.length <= 5);
});

Deno.test("similar query parameters are parsed and wired through", async () => {
  // A section-level target with a path; level inferred from the path's presence.
  const section = await getJson<SimilarResponse>(
    "/similar?author=test&work=tw&path=1&limit=5",
  );
  assertEquals(section.level, "section");
  assertEquals(section.author, "test");
  assertEquals(section.work, "tw");
  assertEquals(section.edition, "1760"); // tw's canonical edition
  assertEquals(section.sectionPath, ["1"]);
  assert(section.found);
  assert(section.results.length <= 5);
  // The target's own work never appears among the results.
  assert(section.results.every((r) => r.work !== "tw"));

  // An explicit level and an unknown work fall through to a not-found body.
  const missing = await getJson<SimilarResponse>(
    "/similar?author=test&work=nope&level=work",
  );
  assertEquals(missing.level, "work");
  assert(!missing.found);
  assertEquals(missing.results.length, 0);
});

Deno.test("topics query parameters are parsed and wired through", async () => {
  // The model itself: topics with terms and (capped) prominent works.
  const model = await getJson<TopicsResponse>("/topics?terms=5&works=3");
  assert(model.k >= 1);
  assertEquals(model.topics.length, model.k);
  for (const topic of model.topics) {
    assert(topic.terms.length <= 5);
    assert(topic.prominent.length <= 3);
  }

  // A target's mix; level inferred from the path's presence.
  const mix = await getJson<TopicMixResponse>(
    "/topics/mix?author=test&work=tw&path=1&limit=4",
  );
  assertEquals(mix.level, "section");
  assertEquals(mix.author, "test");
  assertEquals(mix.work, "tw");
  assertEquals(mix.edition, "1760"); // tw's canonical edition
  assertEquals(mix.sectionPath, ["1"]);
  assert(mix.found);
  assert(mix.topics.length <= 4);

  // An unknown work falls through to a not-found body.
  const missing = await getJson<TopicMixResponse>(
    "/topics/mix?author=test&work=nope&level=work",
  );
  assertEquals(missing.level, "work");
  assert(!missing.found);
  assertEquals(missing.topics.length, 0);
});

Deno.test("unknown resources return JSON 404s", async () => {
  for (
    const path of [
      "/nope",
      "/authors/test/works/tw", // old route shape (connector words gone)
      "/authors", // no work
      "/authors/nope/tw",
      "/authors/test/nope",
      "/authors/other/tw", // wrong author
      "/authors/test/tw/1234", // not a real edition (year-shaped though)
      "/authors/test/tw/99", // not a real section
      "/authors/test/tw/compare/1750/1750", // an edition with itself
      "/authors/test/tw/compare/1750/1760/99", // no such section to diff
      "/authors/test/tw/compare/1750", // compare needs two edition slugs
      "/topics/bogus", // an unknown /topics subroute
    ]
  ) {
    const response = await request(path);
    assertEquals(response.status, 404, `expected 404 for ${path}`);
    assertEquals((await response.json()).error, "not found");
  }
});

Deno.test("a falsey flag value is accepted and read as false", async () => {
  // The truth words 0/false are the off side of caseSensitive (the on side, 1,
  // is exercised above); both resolve, neither errors.
  for (const value of ["false", "0"]) {
    const response = await request(`/search?q=virtue&caseSensitive=${value}`);
    assertEquals(response.status, 200, value);
    await response.body?.cancel();
  }
});

Deno.test("the rate limiter evicts refilled buckets once it grows past its cap", async () => {
  // Drive more distinct clients than MAX_BUCKETS (10_000) so the bookkeeping
  // sweep runs. The clock advances each request, so the older buckets have
  // refilled back to their burst and are dropped, while the newest are kept.
  let clock = 0;
  const limited = await handler({
    rateLimit: { ratePerSecond: 1000, burst: 1 },
    now: () => clock,
  });
  for (let i = 0; i < 10_050; i++) {
    clock += 1; // 1ms later: a one-request-old bucket has fully refilled
    const response = await limited(
      new Request("http://localhost/catalog", {
        headers: { "x-forwarded-for": `198.51.100.${i}` },
      }),
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
  }
});

Deno.test("an unexpected failure inside the computer is a 500", async () => {
  // A handler over a computer whose every method throws: the route turns the
  // (non-ParamError) failure into a 500 rather than leaking it.
  const boom = new Proxy({}, {
    get: () => () => {
      throw new Error("boom");
    },
  }) as unknown as Parameters<typeof createHandler>[0]["computer"];
  const handle = createHandler({ computer: boom });
  const originalError = console.error;
  console.error = () => {}; // the route logs the failure; keep the test quiet
  try {
    const response = await handle(new Request("http://localhost/catalog"));
    assertEquals(response.status, 500);
    assertEquals((await response.json()).error, "internal error");
  } finally {
    console.error = originalError;
  }
});

Deno.test("non-GET methods are rejected", async () => {
  const response = await request("/catalog", "POST");
  assertEquals(response.status, 405);
  await response.body?.cancel();
});

Deno.test("the /mcp mount answers a POST (past the GET-only guard)", async () => {
  const handle = await handler();
  const response = await handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "wiring", version: "1.0.0" },
        },
      }),
    }),
  );
  assert(response.ok, `/mcp returned ${response.status}`);
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  await response.body?.cancel();
});

Deno.test("the rate limiter rejects past the burst and refills over time", async () => {
  let clock = 0;
  const limited = await handler({
    rateLimit: { ratePerSecond: 1, burst: 2 },
    now: () => clock,
  });
  const get = async (): Promise<number> => {
    const response = await limited(new Request("http://localhost/catalog"));
    await response.body?.cancel();
    return response.status;
  };
  assertEquals(await get(), 200);
  assertEquals(await get(), 200);
  const refused = await limited(new Request("http://localhost/catalog"));
  assertEquals(refused.status, 429);
  assertEquals(refused.headers.get("retry-after"), "1");
  await refused.body?.cancel();
  clock += 1000; // one token refills
  assertEquals(await get(), 200);
  assertEquals(await get(), 429);
});

Deno.test("clients are rate-limited independently by their forwarded IP", async () => {
  const limited = await handler({
    rateLimit: { ratePerSecond: 1, burst: 1 },
    now: () => 0,
  });
  const get = async (xff: string): Promise<number> => {
    const response = await limited(
      new Request("http://localhost/catalog", {
        headers: { "x-forwarded-for": xff },
      }),
    );
    await response.body?.cancel();
    return response.status;
  };
  assertEquals(await get("203.0.113.1"), 200);
  assertEquals(await get("203.0.113.1"), 429);
  assertEquals(await get("203.0.113.2"), 200); // a different first hop
  assertEquals(await get("203.0.113.1, 10.0.0.9"), 429); // keyed by first hop
});

Deno.test("a non-positive rate disables limiting", async () => {
  const limited = await handler({ rateLimit: { ratePerSecond: 0, burst: 1 } });
  for (let i = 0; i < 50; i++) {
    const response = await limited(new Request("http://localhost/catalog"));
    assertEquals(response.status, 200);
    await response.body?.cancel();
  }
});
