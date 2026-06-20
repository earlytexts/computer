import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { FrequencyParams, SearchParams } from "../src/client.ts";
import { createTools } from "../src/lib/tools.ts";
import { fakeComputer, frequency, search, section } from "./toolFixtures.ts";

Deno.test("every definition has a matching handler", async () => {
  const tools = createTools(fakeComputer({}));
  assertEquals(tools.definitions.length, 8);
  for (const definition of tools.definitions) {
    if (definition.name === "list_authors") {
      assertStringIncludes(await tools.run(definition.name, {}), "hume");
    }
  }
});

Deno.test("frequency passes the query, grouping, and scope through", async () => {
  let captured: FrequencyParams | undefined;
  const tools = createTools(fakeComputer({
    frequency: (params) => {
      captured = params;
      return Promise.resolve(frequency);
    },
  }));
  const out = await tools.run("frequency", {
    q: "human nature",
    by: "work",
    work: "epm",
  });
  assertEquals(captured?.q, "human nature");
  assertEquals(captured?.by, "work");
  assertEquals(captured?.work, "epm");
  assertStringIncludes(out, "grouped by work");
});

Deno.test("get_author_works resolves an author and reports unknown slugs", async () => {
  const tools = createTools(fakeComputer({}));
  assertStringIncludes(
    await tools.run("get_author_works", { author: "hume" }),
    "Works of David Hume",
  );
  assertStringIncludes(
    await tools.run("get_author_works", { author: "berkeley" }),
    'Not found: author "berkeley"',
  );
});

Deno.test("search passes the query, options, and scope through", async () => {
  let captured: SearchParams | undefined;
  const tools = createTools(fakeComputer({
    search: (params) => {
      captured = params;
      return Promise.resolve(search);
    },
  }));
  await tools.run("search", { q: "flames", match: "exact", work: "ehu" });
  assertEquals(captured?.q, "flames");
  assertEquals(captured?.match, "exact");
  assertEquals(captured?.work, "ehu");
  await tools.run("search", { q: "flames", caseSensitive: true });
  assertEquals(captured?.match, undefined); // tolerant ("form") is the default
  assertEquals(captured?.caseSensitive, true);
});

Deno.test("get_section renders a found section and reports 404s", async () => {
  const tools = createTools(fakeComputer({
    section: (_author, _work, _edition, path) =>
      Promise.resolve(path[0] === "1" ? section : undefined),
  }));
  // No edition → the work's canonical edition.
  assertStringIncludes(
    await tools.run("get_section", {
      author: "hume",
      work: "epm",
      path: ["1"],
    }),
    "Disputes with men",
  );
  assertStringIncludes(
    await tools.run("get_section", {
      author: "hume",
      work: "epm",
      edition: "1772",
      path: ["99"],
    }),
    "Not found: section hume/epm/1772 § 99",
  );
});

Deno.test("missing arguments and unknown tools reject", async () => {
  const tools = createTools(fakeComputer({}));
  await assertRejects(
    () => tools.run("search", {}),
    Error,
    'missing required string argument "q"',
  );
  await assertRejects(
    () =>
      tools.run("get_section", {
        author: "hume",
        work: "epm",
        path: [],
      }),
    Error,
    'missing required string array argument "path"',
  );
  await assertRejects(
    () => tools.run("nonsense", {}),
    Error,
    'unknown tool "nonsense"',
  );
});
