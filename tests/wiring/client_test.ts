/**
 * The HTTP client wiring: `computerClient` is the typed `Computer` the computer
 * ships for its callers (davidhume, englishphilosophy, companion). These tests
 * drive every method against the real `createHandler` over the test computer —
 * routing the client's `fetch` into the in-process handler — so the URL each
 * method builds is exercised end to end and round-trips real responses. The
 * stubbed-`fetch` cases below pin the transport contract the handler can't show:
 * 404 → undefined, other failures → a "computer unavailable" throw, the
 * forwarded-IP header, and the per-base-URL catalogue cache.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHandler } from "../../src/server.ts";
import {
  computerClient,
  computerUnavailable,
  isComputerUnavailable,
} from "../../src/client.ts";
import { testComputer } from "../helpers.ts";

/** Run `fn` with `globalThis.fetch` swapped for `fake`, then restore it. */
const withFetch = async <T>(
  fake: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

/** A `fetch` that routes every request into the real HTTP handler. */
const handlerFetch = async (): Promise<typeof fetch> => {
  const computer = await testComputer();
  const handle = createHandler({ computer });
  return ((input, init) =>
    handle(new Request(input as string | URL, init))) as typeof fetch;
};

/** A client whose `fetch` reaches the real handler, on a unique base URL. */
let baseN = 0;
const liveClient = async () => {
  const fetcher = await handlerFetch();
  const base = `http://computer.test/${baseN++}`;
  return { client: computerClient(base), fetcher };
};

Deno.test("client: reading routes round-trip through the handler", async () => {
  const { client, fetcher } = await liveClient();
  await withFetch(fetcher, async () => {
    // catalogue (a `must` route) and the work/edition reading routes.
    const catalogue = await client.catalogue();
    assertEquals(catalogue.authors.length, 2);

    // editionBase: the canonical edition (no edition segment) and a named one.
    const canonical = await client.edition("test", "tw");
    assertEquals(canonical?.edition.slug, "1760");
    const pinned = await client.edition("test", "tw", "1750");
    assertEquals(pinned?.edition.slug, "1750");

    // withVersion: the original-text view appends ?version, edited is the default.
    const original = await client.edition("test", "solo", "1740", "original");
    assertEquals(original?.edition.slug, "1740");
    const edited = await client.edition("test", "solo", "1740", "edited");
    assertEquals(edited?.edition.slug, "1740");

    // full text, section, and section full text (path segments are encoded).
    assert((await client.fullText("test", "tw"))!.blocks.length > 0);
    const section = await client.section("test", "tw", "1760", ["1"]);
    assertEquals(section?.section.path, ["1"]);
    assert(
      (await client.sectionFullText("test", "tw", "1760", ["1"]))!.section
        .blocks.length > 0,
    );

    // compare two editions, and a single section across them.
    assert(
      (await client.compare("test", "tw", "1750", "1760"))!.rows
        .length > 0,
    );
    const cmp = await client.compareSection(
      "test",
      "tw",
      "1750",
      "1760",
      ["1"],
      "original",
    );
    assert(cmp !== undefined);
  });
});

Deno.test("client: analysis routes round-trip through the handler", async () => {
  const { client, fetcher } = await liveClient();
  await withFetch(fetcher, async () => {
    // search: a flag (true → "1"), an enum, numbers, and a scope are all sent.
    const search = await client.search({
      q: "liberty",
      match: "exact",
      caseSensitive: true,
      version: "edited",
      editions: "all",
      page: 1,
      perPage: 5,
    });
    assert(search.total >= 1);

    assert(
      (await client.frequency({ q: "passion", groupBy: "edition" }))
        .total >= 1,
    );
    assert(
      (await client.concordance({ q: "passion", window: 4, sort: "left" }))
        .total >= 1,
    );
    assert(
      (await client.keywords({ author: "test", work: "tw", min: 1 }))
        .results.length >= 0,
    );
    assert(
      (await client.collocations({ q: "liberty", window: 3, min: 1 }))
        .nodeCount >= 0,
    );
    // similar / topicMix with a section path exercise the path-mapping arm.
    assert(
      (await client.similar({ author: "test", work: "tw", path: ["1"] }))
        .level === "section",
    );
    assert((await client.topics({ terms: 5, works: 3 })).k >= 1);
    // topics with no params builds an empty query string (no "?").
    assert((await client.topics({})).k >= 1);
    assert(
      (await client.topicMix({ author: "test", work: "tw", path: ["1"] }))
        .level === "section",
    );
  });
});

Deno.test("client: a 404 on a nullable route resolves to undefined", async () => {
  const { client, fetcher } = await liveClient();
  await withFetch(fetcher, async () => {
    assertEquals(await client.edition("test", "nope"), undefined);
    assertEquals(await client.section("test", "tw", "1760", ["99"]), undefined);
  });
});

Deno.test("client: a 404 on a required route is an error, not undefined", async () => {
  // `must` routes (here /catalogue) treat a 404 as a contract violation.
  const stub =
    (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch;
  const client = computerClient("http://gone.test");
  await withFetch(stub, () =>
    assertRejects(
      () => client.catalogue(),
      Error,
      "computer has no /catalogue",
    ));
});

Deno.test("client: a non-404 failure throws computer-unavailable", async () => {
  const client = computerClient("http://broken.test");
  // A 5xx (with a body that must be drained).
  const fiveHundred =
    (() =>
      Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch;
  const serverError = await withFetch(
    fiveHundred,
    () => assertRejects(() => client.catalogue(), Error),
  );
  assert(isComputerUnavailable(serverError));

  // A transport failure (fetch itself rejects).
  const refused =
    (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch;
  const networkError = await withFetch(
    refused,
    () => assertRejects(() => client.catalogue(), Error),
  );
  assert(isComputerUnavailable(networkError));

  // A non-Error rejection is still surfaced as unavailable.
  const odd = (() => Promise.reject("nope")) as typeof fetch;
  const oddError = await withFetch(
    odd,
    () => assertRejects(() => client.catalogue(), Error),
  );
  assert(isComputerUnavailable(oddError));
});

Deno.test("client: the forwarded client IP is sent only when given", async () => {
  let seen: string | null = "unset";
  const capture = ((_input, init) => {
    seen = new Headers(init?.headers).get("x-forwarded-for");
    return Promise.resolve(Response.json({ authors: [], works: 0 }));
  }) as typeof fetch;

  await withFetch(capture, async () => {
    await computerClient("http://ip.test/a").catalogue();
    assertEquals(seen, null); // no IP → no header
    await computerClient("http://ip.test/b", "203.0.113.7").catalogue();
    assertEquals(seen, "203.0.113.7");
  });
});

Deno.test("client: the catalogue is cached per base URL until it expires", async () => {
  let calls = 0;
  const counting = (() => {
    calls++;
    return Promise.resolve(Response.json({ authors: [], works: 0 }));
  }) as typeof fetch;
  const base = "http://cache.test";
  const client = computerClient(base);

  const realNow = Date.now;
  try {
    await withFetch(counting, async () => {
      let clock = 1_000_000;
      Date.now = () => clock;
      await client.catalogue();
      await client.catalogue(); // within the TTL: served from cache
      assertEquals(calls, 1);
      clock += 60_001; // past the 60s TTL
      await client.catalogue(); // refetched
      assertEquals(calls, 2);
    });
  } finally {
    Date.now = realNow;
  }
});

Deno.test("computerUnavailable marks its error; isComputerUnavailable detects it", () => {
  const err = computerUnavailable("down");
  assert(isComputerUnavailable(err));
  assert(err.message.includes("down"));
  assert(!isComputerUnavailable(new Error("ordinary")));
  assert(!isComputerUnavailable("not even an error"));
});
