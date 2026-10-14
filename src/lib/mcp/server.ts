/*
 * The MCP endpoint's protocol (15 Oct): JSON-RPC over one POST, as the
 * Streamable HTTP transport allows when a server has nothing to push. No
 * session, no event stream — every request carries its bearer and stands
 * alone, which is what lets Railway restart the OS mid-conversation without
 * Claude noticing.
 *
 * Pure: the tools, their runner and the instructions are handed in, so the
 * protocol is tested without a database (server.test.ts). What the tools ARE
 * is lib/mcp/tools.ts.
 */

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpContext {
  tools: McpTool[];
  instructions: string;
  /** Runs one tool. May throw: the error is told to Claude, not raised. */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  serverVersion?: string;
}

type Json = Record<string, unknown>;
type Id = string | number | null;

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: Id, result: Json) => ({ jsonrpc: "2.0", id, result });

/** What a tool's answer becomes: its JSON as text — the tools already return plain, labelled data. */
function toContent(value: unknown): Json {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: "text", text }] };
}

async function handleOne(message: unknown, ctx: McpContext): Promise<Json | null> {
  if (!message || typeof message !== "object" || (message as Json).jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid request: expected a JSON-RPC 2.0 message.");
  }
  const m = message as Json;
  const method = typeof m.method === "string" ? m.method : null;
  const hasId = "id" in m && (typeof m.id === "string" || typeof m.id === "number");
  const id: Id = hasId ? (m.id as string | number) : null;

  // A response or a notification: nothing to answer.
  if (!method || !hasId) return null;

  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Json;

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "brokerstaffer-os", title: "BrokerStaffer OS", version: ctx.serverVersion ?? "1.0.0" },
        instructions: ctx.instructions,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: ctx.tools });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!ctx.tools.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name || "(none)"}`);
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json;
      try {
        return rpcResult(id, toContent(await ctx.call(name, args)));
      } catch (error) {
        // A failed tool is an ANSWER ("Client Health did not respond"), not a protocol error.
        return rpcResult(id, { ...toContent(error instanceof Error ? error.message : String(error)), isError: true });
      }
    }
    // Asked by some clients even when not advertised; empty is the honest answer.
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * One POST body — a message or (older clients) a batch. Null when there is
 * nothing to send back, which the route answers with 202.
 */
export async function handleMcpBody(body: unknown, ctx: McpContext): Promise<Json | Json[] | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(m, ctx)))).filter((r): r is Json => r !== null);
    return out.length ? out : null;
  }
  return handleOne(body, ctx);
}
