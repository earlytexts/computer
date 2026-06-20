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
import { createMcpServer } from "./lib/mcp.ts";

// Startup logs go to stderr; stdout carries the MCP protocol.
const artefacts = await loadForServing(
  corpusDir(),
  artefactsDir(),
  console.error,
);

await createMcpServer(artefacts).connect(new StdioServerTransport());
