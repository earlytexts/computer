/**
 * The MCP server: exposes the corpus tools (tools.ts) over the Model Context
 * Protocol, so any MCP client — the Companion, Claude Desktop, an editor — gets
 * the same rendered tools the Companion configures its model with. Both
 * factories take a `Computer`; in production that is the in-process core (so the
 * tools run with no HTTP hop), but it could equally be the HTTP client.
 *
 * Two transports, one tool set:
 *   - createMcpServer — a connectable Server for stdio (stdio.ts) or any
 *     transport the caller wires up;
 *   - createMcpHandler — the stateless Streamable HTTP handler mounted at /mcp
 *     (server.ts): a fresh Server + transport per request (the web-standard
 *     transport requires this), replying with a single JSON response rather
 *     than an SSE stream.
 *
 * Both build their tools the same way (createTools); the HTTP handler builds
 * them once and reuses them across requests.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createTools, type ToolSet } from "./tools.ts";
import type { Computer } from "./types.ts";

/** A JSON Schema object, as the MCP tool list expects each `inputSchema`. */
type JsonSchemaObject = { type: "object" } & Record<string, unknown>;

/** Wrap a tool set in an MCP Server, ready to connect to any transport. */
const buildMcpServer = (tools: ToolSet): Server => {
  const server = new Server(
    { name: "early-texts-computer", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as JsonSchemaObject,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (
    request: {
      params: { name: string; arguments?: Record<string, unknown> };
    },
  ) => {
    try {
      const text = await tools.run(
        request.params.name,
        request.params.arguments ?? {},
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: error instanceof Error ? error.message : String(error),
        }],
        isError: true,
      };
    }
  });
  return server;
};

/**
 * A connectable MCP Server over a `Computer`, ready for any transport — stdio.ts
 * connects it to a StdioServerTransport.
 */
export const createMcpServer = (computer: Computer): Server =>
  buildMcpServer(createTools(computer));

/**
 * Build an MCP request handler over a `Computer`. The returned function turns
 * one Streamable HTTP `Request` into its `Response`; mount it on a route (see
 * server.ts) for POST/GET/DELETE to `/mcp`. The tool set is built once; a fresh
 * Server + transport is made per request (stateless HTTP transports are
 * single-use).
 */
export const createMcpHandler = (
  computer: Computer,
): (req: Request) => Promise<Response> => {
  const tools = createTools(computer);
  return async (req: Request): Promise<Response> => {
    const server = buildMcpServer(tools);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return await transport.handleRequest(req);
  };
};
