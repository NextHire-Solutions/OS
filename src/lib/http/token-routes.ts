/*
 * Routes a machine caller may reach with `x-admin-token` instead of a session.
 *
 * Keyed by path AND method. The proxy used to open a listed path for ANY method
 * as soon as the header was present — any value — and trust the handler to
 * check it. /api/tools/client-health/clients checks the token on GET only; its
 * POST, PATCH and DELETE assumed the proxy had established a session. So a
 * request carrying `x-admin-token: anything` could create, edit or delete a
 * Client Health client without signing in. Only the method a route actually
 * verifies the token on is opened here; every other method needs a session.
 */
export const TOKEN_ROUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ["/api/tools/client-health/clients", ["GET"]],
  ["/api/tools/client-health/clients/status", ["GET"]],
  ["/api/tools/client-health/clients/onboard", ["POST"]],
  ["/api/tools/client-health/metrics/weekly", ["GET"]],
  // The OS's own client-status feed, read server-to-server by MasterInbox to
  // decide which portals are open. The handler verifies OS_CLIENT_STATUS_TOKEN
  // and fails closed when that is unset.
  ["/api/workspace/clients/status-feed", ["GET"]],
]);

/** True when this request may skip the session check to reach its handler's own token check. */
export function tokenRouteOpen(pathname: string, method: string, hasToken: boolean): boolean {
  if (!hasToken) return false;
  return TOKEN_ROUTES.get(pathname)?.includes(method.toUpperCase()) ?? false;
}
