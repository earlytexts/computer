/**
 * Stdio entry point for local testing with Claude Desktop.
 *
 * Starts the same MCP server as the HTTP build, but over stdio instead of
 * Streamable HTTP — allowing Claude Desktop (which only supports local stdio
 * servers) to connect directly.
 *
 * All startup messages go to stderr; stdout is reserved for the MCP protocol.
 *
 * Usage (Claude Desktop config):
 *   {
 *     "command": "deno",
 *     "args": ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env",
 *              "/path/to/computer/src/stdio.ts"]
 *   }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { artefactsDir, corpusDir } from "./lib/config.ts";
import { loadForServing } from "./lib/pipeline.ts";
import { createBlockStore } from "./lib/store.ts";
import { localComputer } from "./lib/localComputer.ts";
import { buildMcpServer } from "./lib/mcp.ts";
import { createTools } from "./lib/tools.ts";

// Startup logs go to stderr; stdout carries the MCP protocol.
const artefacts = await loadForServing(
  corpusDir(),
  artefactsDir(),
  console.error,
);

const store = createBlockStore(artefacts);
const tools = createTools(localComputer(artefacts, store));
const server = buildMcpServer(tools);
await server.connect(new StdioServerTransport());
