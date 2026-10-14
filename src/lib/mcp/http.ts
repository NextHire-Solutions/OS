/*
 * Responses for the connector's public endpoints (/api/mcp, /api/oauth/token,
 * /api/oauth/register, /.well-known/*).
 *
 * Any origin may call them: they authenticate with a bearer token or a PKCE
 * verifier, never a cookie, and no response here sets
 * Access-Control-Allow-Credentials — so a browser page elsewhere gains
 * nothing it could not get by asking from a server. (The consent page and its
 * POST are NOT here: they run on the OS session and keep the OS's rules.)
 */

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
