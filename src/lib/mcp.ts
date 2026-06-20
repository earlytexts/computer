/**
 * The MCP server: exposes the corpus tools (tools.ts) over the Model Context
 * Protocol, so any MCP client — the Companion, Claude Desktop, an editor — gets
 * the same rendered tools the Companion configures its model with. Tools run
 * in-process against the artefacts via localComputer (no HTTP hop).
 *
 * Transport is Streamable HTTP in stateless mode: every request gets a fresh
 * Server + transport (the web-standard transport requires this), and replies
 * with a single JSON response rather than an SSE stream. The tool set itself is
 * built once and shared across requests.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { BlockStore, ServeArtefacts } from "./artefacts.ts";
import { localComputer } from "./localComputer.ts";
import { createTools, type ToolSet } from "./tools.ts";

/** A JSON Schema object, as the MCP tool list expects each `inputSchema`. */
type JsonSchemaObject = { type: "object" } & Record<string, unknown>;

/**
 * Create and configure an MCP Server for the given tool set. The server is
 * ready to connect to any transport (HTTP or stdio); callers supply the
 * transport themselves.
 */
export const buildMcpServer = (tools: ToolSet): Server => {
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
 * Build an MCP request handler over the computer's artefacts. The returned
 * function turns one Streamable HTTP `Request` into its `Response`; mount it on
 * a route (see server.ts) for POST/GET/DELETE to `/mcp`.
 */
export const createMcpHandler = (
  artefacts: ServeArtefacts,
  store: BlockStore,
): (req: Request) => Promise<Response> => {
  const tools = createTools(localComputer(artefacts, store));

  // A fresh Server per request: stateless HTTP transports are single-use.
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
