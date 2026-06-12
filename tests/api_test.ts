/**
 * Smoke tests for the HTTP API: the handler is a thin shell over api.ts,
 * so these only check routing, status codes, and response shapes.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { createHandler } from "../src/server.ts";
import { createRateLimiter } from "../src/ratelimit.ts";
import { testData } from "./helpers.ts";
import type {
  CatalogResponse,
  CompareResponse,
  CompareSectionResponse,
  EditionResponse,
  FullTextResponse,
  SearchResponse,
  SectionResponse,
} from "../src/types.ts";

const request = async (path: string, method = "GET"): Promise<Response> => {
  const { catalog, searchIndex } = await testData();
  return createHandler({ catalog, searchIndex })(
    new Request(`http://localhost${path}`, { method }),
  );
};

const getJson = async <T>(path: string): Promise<T> => {
  const response = await request(path);
  assertEquals(response.status, 200, `expected 200 for ${path}`);
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  return await response.json() as T;
};

Deno.test("the root reports service health", async () => {
  const info = await getJson<{ service: string; works: number }>("/");
  assertEquals(info.service, "computer");
  assertEquals(info.works, 3);
});

Deno.test("/catalog lists works and editions", async () => {
  const catalog = await getJson<CatalogResponse>("/catalog");
  const tw = catalog.works.find((w) => w.slug === "tw");
  assertExists(tw);
  assertEquals(tw.editions.map((e) => e.slug), ["main", "1750", "1760"]);
  assert(catalog.editionSlugs.includes("main"));
  assert(catalog.editionSlugs.includes("1750"));
});

Deno.test("an edition has title blocks and a section tree", async () => {
  const edition = await getJson<EditionResponse>("/works/tw/editions/main");
  assertEquals(edition.edition.slug, "main");
  assert(edition.blocks.length > 0);
  assertEquals(edition.sections.map((s) => s.slug), ["1", "2"]);
  assertEquals(edition.work.editions.length, 3); // for the edition strip
});

Deno.test("the full text includes every section's blocks", async () => {
  const full = await getJson<FullTextResponse>("/works/tw/editions/main/full");
  assertEquals(full.sections.length, 2);
  assert(full.sections.every((s) => s.blocks.length > 0));
});

Deno.test("a section comes with navigation and compare info", async () => {
  const section = await getJson<SectionResponse>(
    "/works/tw/editions/main/sections/1",
  );
  assertEquals(section.section.title, "Section 1");
  assert(section.section.blocks.length > 0);
  assertEquals(section.prev, undefined);
  assertEquals(section.next?.path, ["2"]);
  assertEquals(section.compareEditions, ["1750", "1760"]);
});

Deno.test("a section unique to one edition offers no comparisons", async () => {
  const section = await getJson<SectionResponse>(
    "/works/tw/editions/1750/sections/3",
  );
  assertEquals(section.compareEditions, []);
});

Deno.test("compare aligns the two editions' sections", async () => {
  const compared = await getJson<CompareResponse>(
    "/works/tw/compare/1750/main",
  );
  assertEquals(compared.rows.map((row) => row.key), ["1", "3", "2"]);
  const shared = compared.rows[0];
  assert(shared.pathA !== undefined && shared.pathB !== undefined);
  assertEquals(compared.rows[1].pathB, undefined); // 3 only in 1750
  assertEquals(compared.rows[2].pathA, undefined); // 2 only in main
});

Deno.test("compare of a section yields word-level diffs", async () => {
  const compared = await getJson<CompareSectionResponse>(
    "/works/tw/compare/1750/main/sections/1",
  );
  assertEquals(compared.title, "Section 1");
  const changed = compared.diffs.find((diff) => diff.type === "changed");
  assertExists(changed);
  const deleted = changed.ops.filter((op) => op.type === "delete")
    .flatMap((op) => op.tokens.map((t) => t.text));
  const inserted = changed.ops.filter((op) => op.type === "insert")
    .flatMap((op) => op.tokens.map((t) => t.text));
  assert(deleted.includes("betwixt"));
  assert(inserted.includes("between"));
  // paragraph #3 exists only in 1750
  assert(compared.diffs.some((diff) => diff.type === "deleted"));
});

Deno.test("search returns ranked, snippeted results", async () => {
  const found = await getJson<SearchResponse>(
    `/search?q=${encodeURIComponent('"liberty of the press"')}`,
  );
  assert(found.total > 0);
  assertEquals(found.results[0].work, "tw");
  assert(found.results[0].snippet.some((part) => part.marked));
  assertEquals(found.results[0].workBreadcrumb, "Test Work");
});

Deno.test("search filters and paginates", async () => {
  const filtered = await getJson<SearchResponse>(
    "/search?q=sensation&work=tw&edition=1750",
  );
  assert(filtered.results.every((r) => r.edition === "1750"));
  const paged = await getJson<SearchResponse>(
    "/search?q=paragraph&perPage=1&page=2",
  );
  assertEquals(paged.page, 2);
  assertEquals(paged.results.length, 1);
  assert(paged.pages > 1);
});

Deno.test("an empty query matches nothing", async () => {
  const found = await getJson<SearchResponse>("/search?q=");
  assertEquals(found.total, 0);
});

Deno.test("unknown resources return JSON 404s", async () => {
  for (
    const path of [
      "/nope",
      "/works/nope/editions/main",
      "/works/tw/editions/1234",
      "/works/tw/editions/main/sections/99",
      "/works/tw/compare/1750/1750", // comparing an edition with itself
      "/works/tw/compare/1750/main/sections/99",
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

Deno.test("requests beyond the rate limit get a 429", async () => {
  const { catalog, searchIndex } = await testData();
  const handler = createHandler({
    catalog,
    searchIndex,
    limiter: createRateLimiter({ ratePerSecond: 1, burst: 2 }),
  });
  const get = () => handler(new Request("http://localhost/catalog"));
  await (await get()).body?.cancel();
  await (await get()).body?.cancel();
  const limited = await get();
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get("retry-after"), "1");
  await limited.body?.cancel();
});
