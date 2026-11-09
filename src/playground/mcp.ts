// The playground's tools as an MCP server, for the agent the user connects.
// Stateless: each HTTP request gets its own server and transport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { callTool, type Tools } from "../agent.ts";
import type { Events } from "./events.ts";

export function mcpServer(tools: Tools, events: Events): McpServer {
  const server = new McpServer({ name: "verdict-playground", version: "1" });
  for (const [name, t] of Object.entries(tools)) {
    server.registerTool(name, { description: t.description, inputSchema: t.schema.shape }, async (input: unknown) => {
      const r = await callTool(t, input);
      events.add("agent", name, summarize(name, input, r.text), r.isError);
      return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
    });
  }
  return server;
}

function summarize(name: string, input: unknown, out: string): string {
  const path = typeof input === "object" && input !== null && "path" in input && typeof input.path === "string" ? input.path : undefined;
  const first = out.split("\n")[0] ?? "";
  return path ? `${path}: ${first}` : `${name}: ${first}`;
}

export async function handleMcp(req: Request, tools: Tools, events: Events): Promise<Response> {
  const server = mcpServer(tools, events);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // The response is fully built (JSON mode), so the pair can go.
    queueMicrotask(() => void server.close());
  }
}
