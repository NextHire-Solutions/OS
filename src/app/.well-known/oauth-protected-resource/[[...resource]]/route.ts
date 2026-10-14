import { json, preflight } from "@/lib/mcp/http";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";

/*
 * RFC 9728: what /api/mcp is and who signs people in to it. Served at the
 * root and at the resource's own path (/.well-known/oauth-protected-resource
 * /api/mcp), which is where the 401's WWW-Authenticate points. Public.
 */

export const dynamic = "force-dynamic";

export function GET() {
  return json(protectedResourceMetadata());
}

export function OPTIONS() {
  return preflight();
}
