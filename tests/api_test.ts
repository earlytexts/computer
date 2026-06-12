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
  const { artefacts } = await testData();
  return await createHandler({ artefacts })(
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
  const info = await getJson<
    { service: string; authors: number; works: number }
  >(
    "/",
  );
  assertEquals(info.service, "computer");
  assertEquals(info.authors, 2);
  assertEquals(info.works, 4);
});

Deno.test("/catalog lists authors, works, and editions", async () => {
  const catalog = await getJson<CatalogResponse>("/catalog");
  assertEquals(catalog.authors.map((a) => a.slug), ["other", "test"]);
  const test = catalog.authors.find((a) => a.slug === "test");
  assertExists(test);
  assertEquals(test.surname, "Test");
  const tw = test.works.find((w) => w.slug === "tw");
  assertExists(tw);
  assertEquals(tw.editions.map((e) => e.slug), ["main", "1750", "1760"]);
  assert(tw.imported);
  const stub = catalog.authors[0].works.find((w) => w.slug === "stub");
  assertExists(stub);
  assertEquals(stub.imported, false);
  assert(catalog.editionSlugs.includes("main"));
  assert(catalog.editionSlugs.includes("1750"));
});

Deno.test("an edition has title blocks and a section tree", async () => {
  const edition = await getJson<EditionResponse>(
    "/authors/test/works/tw/editions/main",
  );
  assertEquals(edition.author.slug, "test");
  assertEquals(edition.edition.slug, "main");
  assert(edition.blocks.length > 0);
  assertEquals(edition.sections.map((s) => s.slug), ["1", "2"]);
  assert(edition.sections.every((s) => s.imported));
  assertEquals(edition.work.editions.length, 3); // for the edition strip
});

Deno.test("the full text includes every section's blocks", async () => {
  const full = await getJson<FullTextResponse>(
    "/authors/test/works/tw/editions/main/full",
  );
  assertEquals(full.sections.length, 2);
  assert(full.sections.every((s) => s.blocks.length > 0));
});

Deno.test("a section comes with navigation and compare info", async () => {
  const section = await getJson<SectionResponse>(
    "/authors/test/works/tw/editions/main/sections/1",
  );
  assertEquals(section.section.title, "Section 1");
  assert(section.section.blocks.length > 0);
  assertEquals(section.prev, undefined);
  assertEquals(section.next?.path, ["2"]);
  assertEquals(section.compareEditions, ["1750", "1760"]);
});

Deno.test("a section unique to one edition offers no comparisons", async () => {
  const section = await getJson<SectionResponse>(
    "/authors/test/works/tw/editions/1750/sections/3",
  );
  assertEquals(section.compareEditions, []);
});

Deno.test("a stub section reports imported = false", async () => {
  const section = await getJson<SectionResponse>(
    "/authors/test/works/solo/editions/main/sections/2",
  );
  assertEquals(section.section.imported, false);
});

Deno.test("compare aligns the two editions' sections", async () => {
  const compared = await getJson<CompareResponse>(
    "/authors/test/works/tw/compare/1750/main",
  );
  assertEquals(compared.rows.map((row) => row.key), ["1", "3", "2"]);
  const shared = compared.rows[0];
  assert(shared.pathA !== undefined && shared.pathB !== undefined);
  assertEquals(compared.rows[1].pathB, undefined); // 3 only in 1750
  assertEquals(compared.rows[2].pathA, undefined); // 2 only in main
});

Deno.test("compare of a section yields word-level diffs", async () => {
  const compared = await getJson<CompareSectionResponse>(
    "/authors/test/works/tw/compare/1750/main/sections/1",
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

/** Collect the text of highlight elements anywhere in a block. */
const markedText = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(markedText);
  if (typeof value !== "object" || value === null) return [];
  const el = value as Record<string, unknown>;
  if (el.type === "highlight") {
    return [
      (el.content as { content: string }[]).map((n) => n.content).join(""),
    ];
  }
  return markedText(el.content);
};

Deno.test("search returns full formatted blocks with marks", async () => {
  const found = await getJson<SearchResponse>(
    `/search?q=${encodeURIComponent('"liberty of the press"')}`,
  );
  assert(found.total > 0);
  assertEquals(found.mode, "normalised");
  const first = found.results[0];
  assertEquals(first.author, "test");
  assertEquals(first.authorName, "Test");
  assertEquals(first.work, "tw");
  assertEquals(first.workBreadcrumb, "Test Work");
  // the whole block comes back, formatted, with the phrase marked
  assert(first.block.content.length > 0);
  assertEquals(markedText(first.block.content), ["liberty of the press"]);
});

Deno.test("search mode selects the matching layer", async () => {
  const normalised = await getJson<SearchResponse>("/search?q=encrease");
  assertEquals(normalised.total, 3);
  const exact = await getJson<SearchResponse>("/search?q=encrease&mode=exact");
  assertEquals(exact.mode, "exact");
  assertEquals(exact.total, 1);
  assertEquals(exact.results[0].edition, "1750");
  assertEquals(markedText(exact.results[0].block.content), ["encrease"]);
});

Deno.test("search filters and paginates", async () => {
  const filtered = await getJson<SearchResponse>(
    "/search?q=sensation&author=test&work=tw&edition=1750",
  );
  assert(filtered.results.every((r) => r.edition === "1750"));
  const noneOfHers = await getJson<SearchResponse>(
    "/search?q=sensation&author=other",
  );
  assertEquals(noneOfHers.total, 0);
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
      "/works/tw/editions/main", // old route shape
      "/authors/nope/works/tw/editions/main",
      "/authors/test/works/nope/editions/main",
      "/authors/other/works/tw/editions/main", // wrong author
      "/authors/test/works/tw/editions/1234",
      "/authors/test/works/tw/editions/main/sections/99",
      "/authors/test/works/tw/compare/1750/1750", // an edition with itself
      "/authors/test/works/tw/compare/1750/main/sections/99",
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
  const { artefacts } = await testData();
  const handler = createHandler({
    artefacts,
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
