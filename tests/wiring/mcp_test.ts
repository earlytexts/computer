/**
 * The MCP wiring: the corpus tools served through a real MCP client/server pair
 * (createMcpServer over the test computer, an in-memory transport). These tests
 * own what MCP adds over the `Computer` — the tool definitions and schemas,
 * argument mapping and dispatch, error wrapping, and the plain-text rendering of
 * each response. The corpus behaviour is pinned in tests/core; one representative
 * call per tool here confirms the wiring and the rendering.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp.ts";
import { testComputer } from "../helpers.ts";
import type { Computer } from "../../src/types.ts";

type CallResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

/** A connected MCP client over the test computer, plus a close hook. */
const connect = async (): Promise<
  { client: Client; close: () => Promise<void> }
> => {
  const computer = await testComputer();
  const server = createMcpServer(computer);
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

/** Run a tool and return its rendered text and error flag. */
const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const result = await client.callTool({ name, arguments: args }) as CallResult;
  return { text: result.content[0].text, isError: result.isError === true };
};

Deno.test("lists every tool with a name, description, and object schema", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assertEquals(tools.length, 16);
    assertEquals(
      tools.map((t: { name: string }) => t.name).sort(),
      [
        "collocations",
        "compare_editions",
        "compare_section",
        "concordance",
        "frequency",
        "get_author_works",
        "get_edition",
        "get_full_text",
        "get_section",
        "get_section_full",
        "keywords",
        "list_authors",
        "search",
        "similar",
        "topic_mix",
        "topics",
      ],
    );
    for (const tool of tools) {
      assert(tool.description && tool.description.length > 0);
      assertEquals(tool.inputSchema.type, "object");
    }
    const search = tools.find((t: { name: string }) => t.name === "search")!;
    assertEquals(search.inputSchema.required, ["q"]);
  } finally {
    await close();
  }
});

Deno.test("tool schemas mirror the Computer interface's params", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const props = (name: string): Record<string, { enum?: string[] }> => {
      const tool = tools.find((t: { name: string }) => t.name === name)!;
      return (tool.inputSchema.properties ?? {}) as Record<
        string,
        { enum?: string[] }
      >;
    };

    // version is exposed wherever the corresponding Computer method accepts it,
    // with edited|original on the search/compare family and the extra "both" on
    // the reading routes — and is absent where the param type has none.
    for (const name of ["search", "frequency", "concordance", "keywords"]) {
      assertEquals(props(name).version?.enum, ["edited", "original"], name);
    }
    assertEquals(props("compare_section").version?.enum, [
      "edited",
      "original",
    ]);
    for (const name of ["get_edition", "get_section"]) {
      assertEquals(
        props(name).version?.enum,
        ["edited", "original", "both"],
        name,
      );
    }
    for (
      const name of [
        "collocations",
        "similar",
        "topics",
        "topic_mix",
        "compare_editions",
      ]
    ) {
      assertEquals(props(name).version, undefined, name);
    }

    // perPage rides alongside page on the paged search routes.
    for (const name of ["search", "concordance"]) {
      assert(props(name).perPage !== undefined, name);
    }
  } finally {
    await close();
  }
});

Deno.test("list_authors renders the catalogue", async () => {
  const { client, close } = await connect();
  try {
    const { text } = await call(client, "list_authors");
    assertStringIncludes(text, "test —");
    assertStringIncludes(text, "Test");
    assertStringIncludes(text, "other —");
  } finally {
    await close();
  }
});

Deno.test("get_author_works resolves an author and reports unknown slugs", async () => {
  const { client, close } = await connect();
  try {
    const works = await call(client, "get_author_works", { author: "test" });
    assertStringIncludes(works.text, "Works of");
    assertStringIncludes(works.text, "tw");
    const unknown = await call(client, "get_author_works", {
      author: "berkeley",
    });
    assertStringIncludes(unknown.text, 'Not found: author "berkeley"');
  } finally {
    await close();
  }
});

Deno.test("get_edition defaults to the work's canonical edition", async () => {
  const { client, close } = await connect();
  try {
    const { text } = await call(client, "get_edition", {
      author: "test",
      work: "tw",
    });
    assertStringIncludes(text, 'edition "1760"');
    assertStringIncludes(text, "Sections");
  } finally {
    await close();
  }
});

Deno.test("get_author_works marks a stub work and its stub editions", async () => {
  const { client, close } = await connect();
  try {
    // The "other" author owns only an un-transcribed work.
    const { text } = await call(client, "get_author_works", {
      author: "other",
    });
    assertStringIncludes(text, "[stub]"); // the stub work and its stub edition
  } finally {
    await close();
  }
});

Deno.test("the reading and compare tools report missing resources", async () => {
  const { client, close } = await connect();
  try {
    const edition = await call(client, "get_edition", {
      author: "test",
      work: "tw",
      edition: "9999",
    });
    assertStringIncludes(edition.text, "Not found");
    const full = await call(client, "get_full_text", {
      author: "test",
      work: "nope",
    });
    assertStringIncludes(full.text, "Not found");
    const editions = await call(client, "compare_editions", {
      author: "test",
      work: "tw",
      a: "1750",
      b: "9999",
    });
    assertStringIncludes(editions.text, "Not found");
    const section = await call(client, "compare_section", {
      author: "test",
      work: "tw",
      a: "1750",
      b: "1760",
      path: ["404"],
    });
    assertStringIncludes(section.text, "Not found");
  } finally {
    await close();
  }
});

Deno.test("get_section renders a section and reports not-found paths", async () => {
  const { client, close } = await connect();
  try {
    const found = await call(client, "get_section", {
      author: "test",
      work: "tw",
      path: ["1"],
    });
    assertStringIncludes(found.text, "§ 1");
    const missing = await call(client, "get_section", {
      author: "test",
      work: "tw",
      path: ["99"],
    });
    assertStringIncludes(missing.text, "Not found: section test/tw/canonical");
  } finally {
    await close();
  }
});

Deno.test("get_full_text and get_section_full load whole subtrees", async () => {
  const { client, close } = await connect();
  try {
    const full = await call(client, "get_full_text", {
      author: "test",
      work: "tw",
    });
    assertStringIncludes(full.text, 'edition "1760"');
    assertStringIncludes(full.text, "§ 1"); // a section body, not just a TOC line
    const subtree = await call(client, "get_section_full", {
      author: "test",
      work: "tw",
      path: ["1"],
    });
    assertStringIncludes(subtree.text, "§ 1");
    const missing = await call(client, "get_section_full", {
      author: "test",
      work: "tw",
      path: ["99"],
    });
    assertStringIncludes(missing.text, "Not found: section test/tw/canonical");
  } finally {
    await close();
  }
});

Deno.test("search renders highlighted hits, and match maps through", async () => {
  const { client, close } = await connect();
  try {
    const tolerant = await call(client, "search", {
      q: "liberty of the press",
    });
    assertStringIncludes(tolerant.text, "«liberty of the press»");
    assertStringIncludes(tolerant.text, "tolerant"); // the default match level
    const exact = await call(client, "search", {
      q: "encrease",
      editions: "all",
      match: "exact",
    });
    assertStringIncludes(exact.text, "exact spelling");
    assertStringIncludes(exact.text, "test/tw/1750");
  } finally {
    await close();
  }
});

Deno.test("frequency renders grouped counts", async () => {
  const { client, close } = await connect();
  try {
    const { text } = await call(client, "frequency", {
      q: "liberty",
      groupBy: "work",
    });
    assertStringIncludes(text, "grouped by work");
    assertStringIncludes(text, "per 1000");
  } finally {
    await close();
  }
});

Deno.test("concordance renders keyword-in-context lines", async () => {
  const { client, close } = await connect();
  try {
    const { text } = await call(client, "concordance", {
      q: "liberty",
      editions: "all",
    });
    assertStringIncludes(text, "«liberty»");
    assertStringIncludes(text, "in context");
  } finally {
    await close();
  }
});

Deno.test("keywords renders a subcorpus's distinctive words", async () => {
  const { client, close } = await connect();
  try {
    const { text } = await call(client, "keywords", {
      author: "test",
      work: "tw",
      min: 1,
    });
    assertStringIncludes(text, "distinctive of test/tw");
    assertStringIncludes(text, "G²=");
  } finally {
    await close();
  }
});

Deno.test("collocations renders a node word's neighbourhood", async () => {
  const { client, close } = await connect();
  try {
    const { text } = await call(client, "collocations", {
      q: "liberty",
      author: "test",
      work: "tw",
      min: 1,
    });
    assertStringIncludes(text, 'collocating with "liberty" in test/tw');
    assertStringIncludes(text, "G²=");
    assertStringIncludes(text, "PMI=");
  } finally {
    await close();
  }
});

Deno.test("similar renders lexically similar items", async () => {
  const { client, close } = await connect();
  try {
    const { text } = await call(client, "similar", {
      author: "test",
      work: "tw",
      level: "work",
    });
    assertStringIncludes(text, "most lexically similar to test/tw");
    assertStringIncludes(text, "similarity");
  } finally {
    await close();
  }
});

Deno.test("topics and topic_mix render the topic model", async () => {
  const { client, close } = await connect();
  try {
    const model = await call(client, "topics", { terms: 4 });
    assertStringIncludes(model.text, "topics");
    assertStringIncludes(model.text, "Topic 0");

    const mix = await call(client, "topic_mix", {
      author: "test",
      work: "tw",
      level: "work",
    });
    assertStringIncludes(mix.text, "topic mix of test/tw");
  } finally {
    await close();
  }
});

Deno.test("compare_editions and compare_section render the differences", async () => {
  const { client, close } = await connect();
  try {
    const aligned = await call(client, "compare_editions", {
      author: "test",
      work: "tw",
      a: "1750",
      b: "1760",
    });
    assertStringIncludes(aligned.text, "aligned with edition");
    assertStringIncludes(aligned.text, "ONLY IN");
    const section = await call(client, "compare_section", {
      author: "test",
      work: "tw",
      a: "1750",
      b: "1760",
      path: ["1"],
    });
    assertStringIncludes(section.text, "[-"); // text only in 1750
    assertStringIncludes(section.text, "{+"); // text only in 1760
  } finally {
    await close();
  }
});

Deno.test("bad arguments and unknown tools come back as tool errors", async () => {
  const { client, close } = await connect();
  try {
    const missing = await call(client, "search", {});
    assert(missing.isError);
    assertStringIncludes(missing.text, 'missing required string argument "q"');

    const noPath = await call(client, "get_section", {
      author: "test",
      work: "tw",
    });
    assert(noPath.isError);
    assertStringIncludes(
      noPath.text,
      'missing required string array argument "path"',
    );

    // A specific edition with no work is the incoherent scope case.
    const badScope = await call(client, "search", {
      q: "virtue",
      edition: "1751",
    });
    assert(badScope.isError);
    assertStringIncludes(badScope.text, "edition");

    const unknown = await call(client, "nonsense");
    assert(unknown.isError);
    assertStringIncludes(unknown.text, 'unknown tool "nonsense"');
  } finally {
    await close();
  }
});

Deno.test("a native array path argument is parsed, and an argument-less call works", async () => {
  const { client, close } = await connect();
  try {
    // MCP passes a section path as a native array (not a "/"-joined string).
    const { isError } = await call(client, "similar", {
      author: "test",
      work: "tw",
      path: ["1"],
      level: "section",
    });
    assert(!isError);
    // A tool invoked with no arguments object at all (the server defaults it).
    const result = await client.callTool({ name: "list_authors" }) as {
      content: { text: string }[];
    };
    assertStringIncludes(result.content[0].text, "test —");
  } finally {
    await close();
  }
});

Deno.test("a native boolean argument is accepted as a flag", async () => {
  const { client, close } = await connect();
  try {
    // MCP arguments arrive as native JSON, so caseSensitive is a real boolean
    // (not a truth word) — the flag parser takes it as-is.
    const { text, isError } = await call(client, "search", {
      q: "liberty",
      caseSensitive: true,
      editions: "all",
    });
    assert(!isError);
    assertStringIncludes(text, "case-sensitive");
  } finally {
    await close();
  }
});

Deno.test("a non-Error thrown below the tool is still wrapped as a tool error", async () => {
  // The MCP boundary stringifies whatever a tool throws, including a value that
  // is not an Error instance.
  const exploding = new Proxy({}, {
    get: () => () => {
      throw "catalogue exploded"; // a bare string, not an Error
    },
  }) as unknown as Computer;
  const server = createMcpServer(exploding);
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const { text, isError } = await call(client, "list_authors");
    assert(isError);
    assertStringIncludes(text, "catalogue exploded");
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("malformed argument values are tool errors, not silent defaults", async () => {
  const { client, close } = await connect();
  try {
    const badEnum = await call(client, "search", {
      q: "virtue",
      match: "fuzzy",
    });
    assert(badEnum.isError);
    assertStringIncludes(badEnum.text, "match");

    const badInt = await call(client, "search", { q: "virtue", page: 1.5 });
    assert(badInt.isError);
    assertStringIncludes(badInt.text, "page");

    const belowFloor = await call(client, "search", {
      q: "virtue",
      perPage: 0,
    });
    assert(belowFloor.isError);
    assertStringIncludes(belowFloor.text, "perPage");

    const unknownArg = await call(client, "search", { q: "virtue", limt: 5 });
    assert(unknownArg.isError);
    assertStringIncludes(unknownArg.text, 'unknown argument "limt"');
  } finally {
    await close();
  }
});
