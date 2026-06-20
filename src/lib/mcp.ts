/**
 * The MCP server: exposes the corpus tools (tools.ts) over the Model Context
 * Protocol, so any MCP client — the Companion, Claude Desktop, an editor — gets
 * the same rendered tools the Companion configures its model with. Tools run
 * in-process against the artefacts via localComputer (no HTTP hop).
 *
 * Two transports, one tool set:
 *   - createMcpServer — a connectable Server for stdio (stdio.ts) or any
 *     transport the caller wires up;
 *   - createMcpHandler — the stateless Streamable HTTP handler mounted at /mcp
 *     (server.ts): a fresh Server + transport per request (the web-standard
 *     transport requires this), replying with a single JSON response rather
 *     than an SSE stream.
 *
 * Both build their tools the same way (corpusTools); the HTTP handler builds
 * them once and reuses them across requests.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServeArtefacts } from "./artefacts.ts";
import { type BlockStore, createBlockStore } from "./serve/store.ts";
import { localComputer } from "./serve/localComputer.ts";
import { createTools, type ToolSet } from "./serve/tools.ts";

/** A JSON Schema object, as the MCP tool list expects each `inputSchema`. */
type JsonSchemaObject = { type: "object" } & Record<string, unknown>;

/** The corpus tool set bound to in-process artefacts (no HTTP hop). */
const corpusTools = (artefacts: ServeArtefacts, store: BlockStore): ToolSet =>
  createTools(localComputer(artefacts, store));

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
 * A connectable MCP Server over the computer's artefacts, ready for any
 * transport — stdio.ts connects it to a StdioServerTransport. Pass a block
 * store to share one (the HTTP path shares the REST routes' store); omit it and
 * a private store is created.
 */
export const createMcpServer = (
  artefacts: ServeArtefacts,
  store: BlockStore = createBlockStore(artefacts),
): Server => buildMcpServer(corpusTools(artefacts, store));

/**
 * Build an MCP request handler over the computer's artefacts. The returned
 * function turns one Streamable HTTP `Request` into its `Response`; mount it on
 * a route (see server.ts) for POST/GET/DELETE to `/mcp`. The tool set is built
 * once; a fresh Server + transport is made per request (stateless HTTP
 * transports are single-use).
 */
export const createMcpHandler = (
  artefacts: ServeArtefacts,
  store: BlockStore,
): (req: Request) => Promise<Response> => {
  const tools = corpusTools(artefacts, store);
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
