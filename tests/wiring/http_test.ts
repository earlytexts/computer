/**
 * The HTTP wiring: createHandler over a `Computer`. These tests own only what
 * the HTTP shell adds — routing, query parsing, status codes, headers, the
 * rate limiter, and the /mcp mount. The corpus behaviour (scoping, pagination,
 * grouping, version, diffs) is pinned through `Computer` in tests/core; here a
 * query like match=exact is used only to prove the parameter is wired through.
 */

import { assert, assertEquals } from "@std/assert";
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

Deno.test("search query parameters are parsed and wired through", async () => {
  // match + edition scope reach the computer
  const exact = await getJson<SearchResponse>(
    "/search?q=encrease&match=exact&edition=all",
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
    "/search?q=paragraph&edition=all&perPage=1&page=2",
  );
  assertEquals(paged.page, 2);
  assertEquals(paged.results.length, 1);
  assert(paged.pages > 1);
});

Deno.test("keywords query parameters are parsed and wired through", async () => {
  const response = await getJson<KeywordsResponse>(
    "/keywords?author=test&work=tw&by=surface&min=1&limit=5",
  );
  assertEquals(response.by, "surface");
  assertEquals(response.author, "test");
  assertEquals(response.work, "tw");
  assert(response.results.length <= 5);
  assert(response.results.some((r) => r.term === "liberty"));
});

Deno.test("collocations query parameters are parsed and wired through", async () => {
  const response = await getJson<CollocationsResponse>(
    "/collocations?q=liberty&author=test&work=tw&by=surface&window=3&min=1&limit=5",
  );
  assertEquals(response.q, "liberty");
  assertEquals(response.by, "surface");
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
      "/works/tw", // old route shape (no authors prefix)
      "/authors/nope/works/tw",
      "/authors/test/works/nope",
      "/authors/other/works/tw", // wrong author
      "/authors/test/works/tw/editions/main", // "main" is not exposed
      "/authors/test/works/tw/editions/1234",
      "/authors/test/works/tw/sections/99",
      "/authors/test/works/tw/compare/1750/1750", // an edition with itself
      "/authors/test/works/tw/compare/1750/1760/sections/99",
    ]
  ) {
    const response = await request(path);
    assertEquals(response.status, 404, `expected 404 for ${path}`);
    assertEquals((await response.json()).error, "not found");
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
