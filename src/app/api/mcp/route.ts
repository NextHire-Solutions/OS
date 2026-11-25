import { connectorUserCheck } from "@/lib/mcp/access";
import { CORS, json, preflight } from "@/lib/mcp/http";
import { authenticate, wwwAuthenticate } from "@/lib/mcp/oauth";
import { handleMcpBody } from "@/lib/mcp/server";
import { instructionsFor, mcpTools, runMcpTool, type ConnectorViewer } from "@/lib/mcp/tools";
import { grantStore } from "@/lib/identity/store";
import { isAdminUser } from "@/lib/identity/admin-db";
import { canUseBillingTab } from "@/lib/clients/billing-people";

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
  // Who is asking decides the tools (25 Nov): an admin, every tool; a person named for the connector, only what their
  // switches open (the Assistant's viewer rules) and only the actions they could take on the OS screen.
  const user = await grantStore().findByEmail(email);
  const viewer: ConnectorViewer = {
    email,
    admin: await isAdminUser(email),
    grants: user?.grants ?? [],
    billing: await canUseBillingTab(email),
  };
  const out = await handleMcpBody(body, {
    tools: mcpTools(viewer),
    instructions: instructionsFor(viewer),
    call: async (name, args) => {
      const started = Date.now();
      try {
        const result = await runMcpTool(name, args, viewer);
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
