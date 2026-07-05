/**
 * End-to-end: the HTTP entry point (src/main.ts) as a spawned process. It boots
 * against the fixture corpus (rebuilding artefacts into a temp dir), then we hit
 * it through the vendored typed client (src/client.ts) — exercising the real
 * Deno.serve path — and confirm the /mcp mount answers the protocol handshake.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { computerClient } from "../../src/client.ts";
import { materializeCorpus, testCorpus } from "../corpus.ts";

const root = new URL("../../", import.meta.url).pathname;
const denoFlags = [
  "run",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-net",
];

const freePort = (): number => {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
};

const waitForServer = async (base: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    try {
      const response = await fetch(base);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server did not become ready");
};

Deno.test("main.ts serves the REST API and mounts MCP", async () => {
  const corpus = await materializeCorpus(testCorpus());
  const dir = await Deno.makeTempDir({ prefix: "computer-e2e-serve-" });
  const port = freePort();
  const base = `http://localhost:${port}`;
  const child = new Deno.Command(Deno.execPath(), {
    args: [...denoFlags, "src/main.ts"],
    cwd: root,
    env: { CORPUS_DIR: corpus, ARTEFACTS_DIR: dir, PORT: String(port) },
    stdout: "null",
    stderr: "piped",
  }).spawn();

  try {
    await waitForServer(base);

    // REST, through the typed client other repos vendor.
    const computer = computerClient(base);
    const catalogue = await computer.catalogue();
    assertEquals(catalogue.authors.map((a) => a.slug), ["other", "test"]);
    const found = await computer.search({ q: "liberty of the press" });
    assert(found.total > 0);
    const section = await computer.section("test", "tw", undefined, ["1"]);
    assertEquals(section?.section.title, "Section 1");

    // MCP mount: the initialize handshake returns this server's identity.
    const mcp = await fetch(`${base}/mcp`, {
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
          clientInfo: { name: "e2e", version: "1.0.0" },
        },
      }),
    });
    assert(mcp.ok, `/mcp returned ${mcp.status}`);
    assertStringIncludes(await mcp.text(), "early-texts-computer");
  } finally {
    child.kill("SIGTERM");
    await child.stderr.cancel();
    await child.status;
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(corpus, { recursive: true });
  }
});
