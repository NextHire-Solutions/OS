import { connectorUserCheck } from "@/lib/mcp/access";
import { CORS, json, preflight } from "@/lib/mcp/http";
import { authenticate, wwwAuthenticate } from "@/lib/mcp/oauth";
import { handleMcpBody } from "@/lib/mcp/server";
import { INSTRUCTIONS, mcpTools, runMcpTool } from "@/lib/mcp/tools";

/*
 * BrokerStaffer OS for Claude (15 Oct): the MCP endpoint a Claude connector
 * is pointed at — https://os.brokerstaffer.com/api/mcp.
 *
 * Open at the proxy (src/proxy.ts) because Claude carries no OS cookie; this
 * handler checks the bearer instead, on every request (lib/mcp/oauth.ts
 * `authenticate`), against the live user record. The tools are the
 * Assistant's, read-only (lib/mcp/tools.ts). Every tool call is logged with
 * who asked: `[mcp] <email> <tool> ok|failed <ms>`.
 */

export const dynamic = "force-dynamic";
// client_report reads every product for a client; the platform default would cut it off.
export const maxDuration = 120;

export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return json({ error: "server_error", error_description: "The OS is not configured to sign anyone in." }, 503);

  const authorization = request.headers.get("authorization");
  const auth = await authenticate(secret, authorization, connectorUserCheck);
  if (!auth.ok) {
    return json({ error: auth.error, error_description: auth.description }, auth.status, {
      "WWW-Authenticate": wwwAuthenticate(authorization ? auth.error : null, auth.description),
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body is not JSON." } }, 400);
  }

  const email = auth.email;
  const out = await handleMcpBody(body, {
    tools: mcpTools(),
    instructions: INSTRUCTIONS,
    call: async (name, args) => {
      const started = Date.now();
      try {
        const result = await runMcpTool(name, args);
        console.info(`[mcp] ${email} ${name} ok ${Date.now() - started}ms`);
        return result;
      } catch (error) {
        console.warn(`[mcp] ${email} ${name} failed ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
  });

  // Only notifications in the body: accepted, nothing to say.
  if (out === null) return new Response(null, { status: 202, headers: CORS });
  return json(out);
}

/** No event stream: this server never pushes, so a GET for one is refused, as the transport allows. */
export function GET() {
  return json({ error: "This endpoint answers POST only." }, 405, { Allow: "POST, OPTIONS" });
}

export function DELETE() {
  return json({ error: "There is no session to end." }, 405, { Allow: "POST, OPTIONS" });
}

export function OPTIONS() {
  return preflight();
}
