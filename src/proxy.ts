import { NextResponse, type NextRequest } from "next/server";
import { readSsoCookie, verifySso } from "@/lib/bs-auth";

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

  const response = NextResponse.next();
  // The shell reads these to build the sidebar, so an ungranted tool is never
  // rendered. The apps enforce it again themselves — this is presentation.
  response.headers.set("x-bs-user", session.email);
  response.headers.set("x-bs-grants", session.grants.join(","));
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
