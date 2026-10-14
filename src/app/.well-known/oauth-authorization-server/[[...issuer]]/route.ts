import { json, preflight } from "@/lib/mcp/http";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";

/*
 * RFC 8414: where Claude signs people in to the OS — the authorization,
 * token and registration endpoints, PKCE S256 only. Served at the root and
 * under any path suffix a client tries. Public.
 */

export const dynamic = "force-dynamic";

export function GET() {
  return json(authorizationServerMetadata());
}

export function OPTIONS() {
  return preflight();
}
