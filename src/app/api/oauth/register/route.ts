import { json, preflight } from "@/lib/mcp/http";
import { registerClient } from "@/lib/mcp/oauth";

/*
 * Dynamic client registration for the Claude connector (RFC 7591, 15 Oct).
 * Claude registers itself here before the first sign-in. Only Claude's own
 * callback addresses and loopback are accepted — see lib/mcp/oauth.ts.
 * Open at the proxy; stores nothing.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return json({ error: "server_error", error_description: "Not configured." }, 503);
  const body = await request.json().catch(() => null);
  const result = await registerClient(secret, body);
  return json(result.body, result.status);
}

export function OPTIONS() {
  return preflight();
}
