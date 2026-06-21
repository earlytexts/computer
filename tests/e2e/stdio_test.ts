/**
 * End-to-end: the stdio entry point (src/stdio.ts) as a spawned process,
 * driven by a real MCP client over stdin/stdout. It boots against the fixture
 * corpus and serves the same corpus tools as the HTTP build — here we confirm
 * the process speaks MCP and answers a tool call.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { materializeCorpus, testCorpus } from "../corpus.ts";

const root = new URL("../../", import.meta.url).pathname;

type CallResult = { content: { type: string; text: string }[] };

Deno.test("stdio.ts serves the corpus tools over MCP", async () => {
  const corpus = await materializeCorpus(testCorpus());
  const dir = await Deno.makeTempDir({ prefix: "computer-e2e-stdio-" });
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "src/stdio.ts",
    ],
    cwd: root,
    env: {
      ...Deno.env.toObject(),
      CORPUS_DIR: corpus,
      ARTEFACTS_DIR: dir,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e", version: "1.0.0" });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assertEquals(tools.length, 16);

    const result = await client.callTool({
      name: "list_authors",
      arguments: {},
    }) as CallResult;
    assertStringIncludes(result.content[0].text, "test —");
  } finally {
    await client.close();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(corpus, { recursive: true });
  }
});
