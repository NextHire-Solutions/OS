import { NextResponse, type NextRequest } from "next/server";
import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { toolForPath } from "@/lib/workspace/tool-paths";
import { PROXY_ALLOWLIST as MASTER_INBOX_PUBLIC } from "@/lib/tools/master-inbox/webhooks/public-paths";

/** Routes an x-admin-token may open without a session. Exact paths, no prefixes. */
const ONBOARDING_INBOUND_PREFIXES = ["/api/tools/onboarding/webhooks", "/api/tools/onboarding/cron"];

const TOKEN_ROUTES = new Set([
  "/api/tools/client-health/clients",
  "/api/tools/client-health/clients/status",
  "/api/tools/client-health/clients/onboard",
  "/api/tools/client-health/metrics/weekly",
]);

/*
 * Next 16 renamed middleware to `proxy`. Same execution model: Edge runtime,
 * runs before every matched request.
 *
 * Order matters — public paths are checked before the session is read, so a
 * broken AUTH_SECRET can't lock out the login page or the healthcheck.
 *
 * `/api/health` is public because Railway's healthcheck has no credential. It
 * deliberately touches no upstream, so a sick tool can never cause Railway to
 * restart *us*.
 *
 * Everything under /api/tools/* IS gated: those responses carry upstream KPIs.
 *
 * ---------------------------------------------------------------------------
 * This app verifies the same bs_sso token as every other app — it just happens
 * to be the one that issues it. Renewal is NOT done here: the proxy runs on the
 * Edge with no access to the grant store, so it cannot re-read grants, and
 * reissuing a token from stale claims would defeat the 30-minute revocation
 * window. The client posts to /api/auth/refresh instead, which does have the
 * store and re-reads from it.
 */

const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/health"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const secret = process.env.AUTH_SECRET;

  // Without a secret nothing can be verified. Fail closed rather than open,
  // but keep public paths reachable so the failure is diagnosable.
  if (!secret) {
    if (isPublic(pathname)) return NextResponse.next();
    return NextResponse.redirect(new URL("/login?error=config", request.url));
  }

  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));

  if (isPublic(pathname)) {
    if (session && pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  /*
   * Machine callers for the Client Health endpoints the OS now publishes
   * itself — the inbound onboarding hook and the three read-only feeds the
   * live tool used to serve. They authenticate with x-admin-token, which each
   * handler checks in constant time and refuses with 401 when wrong; the
   * proxy only lets the request reach the handler. Without this, an outside
   * system holding a valid token would be bounced by the session check before
   * its token was ever read.
   */
  /*
   * Provider webhooks and the ingestion cron carry no session and no
   * x-admin-token — Instantly and EmailBison send what they send. These paths
   * are open at the proxy and each handler enforces its own secret in constant
   * time, failing CLOSED (503) when that secret is unset. The list lives with
   * the receivers so a new receiver cannot be added without being listed here.
   */
  if (MASTER_INBOX_PUBLIC.includes(pathname)) {
    return NextResponse.next();
  }

  /*
   * Onboarding's inbound receivers (Typeform, Calendly, Stripe, Bison,
   * Masterinbox) and its cron routes: no session — each handler verifies the
   * third party's signature or query token, or the bearer secret, and fails
   * closed when its secret is unset. Prefix match because the receivers are one
   * route per provider under a shared folder.
   */
  if (ONBOARDING_INBOUND_PREFIXES.some((p) => pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (TOKEN_ROUTES.has(pathname) && request.headers.has("x-admin-token")) {
    return NextResponse.next();
  }

  /*
   * An external scheduler may trigger analytics sync jobs with the cron
   * bearer. The handler verifies ANALYTICS_CRON_SECRET in constant time and
   * fails closed when it is unset; the proxy only stops bouncing the request
   * for lacking a browser session. The in-process scheduler and the UI's
   * Sync buttons never take this path.
   */
  if (pathname === "/api/tools/analytics/sync/run" && request.headers.get("authorization")?.startsWith("Bearer ")) {
    return NextResponse.next();
  }

  // Same idea for the Client Health sync: a secret-bearing caller (a Railway
  // cron, if one is ever added) may reach the run and tick routes; the handler
  // checks CLIENT_HEALTH_SYNC_SECRET and fails closed when it is unset.
  if ((pathname === "/api/tools/client-health/sync" || pathname === "/api/tools/client-health/sync/tick") &&
      request.headers.has("x-sync-secret")) {
    return NextResponse.next();
  }

  if (!session) {
    // API routes get a 401 rather than an HTML redirect, so fetch() callers see
    // a status they can act on instead of parsing a login page as JSON.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  /*
   * ENFORCE the grant, do not merely advertise it.
   *
   * This block used to be absent, and the comment below used to say the tools
   * enforced it themselves. That was true when they were five separate
   * deployments; it stopped being true when this app started hosting them. A
   * token granting only `analytics` could open `/inbox/all-email`,
   * `/clients`, `/onboarding/pipeline` and `/search/search`, and two of their
   * API routes returned live data. The sidebar hid them, which is cosmetic —
   * a URL is all it took.
   *
   * Screens redirect (a person gets somewhere useful); API routes get a 403,
   * so a fetch() caller can tell "not allowed" from "not signed in".
   */
  const tool = toolForPath(pathname);
  if (tool && !session.grants.includes(tool)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Forbidden", detail: `No access to ${tool}` },
        { status: 403 },
      );
    }
    const home = new URL("/", request.url);
    home.searchParams.set("denied", tool);
    return NextResponse.redirect(home);
  }

  const response = NextResponse.next();
  // The shell reads these to build the sidebar, so an ungranted tool is never
  // rendered either. Presentation on top of the enforcement above.
  response.headers.set("x-bs-user", session.email);
  response.headers.set("x-bs-grants", session.grants.join(","));
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
