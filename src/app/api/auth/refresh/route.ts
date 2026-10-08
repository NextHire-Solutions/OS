import { NextResponse } from "next/server";
import {
  mintSso,
  readSsoCookie,
  ssoCookieOptions,
  SSO_COOKIE,
  verifySso,
} from "@/lib/bs-auth";
import { grantStore } from "@/lib/identity/store";
import { viewerRoles } from "@/lib/identity/viewer-roles";

export const dynamic = "force-dynamic";

/*
 * Silent renewal.
 *
 * Tokens live 30 minutes, which is short on purpose — it is the revocation
 * window. This route trades a still-valid token for a fresh one, and in doing
 * so RE-READS the grants from the store. That is the whole mechanism by which
 * removing someone's access propagates to four apps that never talk to a
 * database: within 30 minutes their next refresh returns a token without that
 * grant, and every app starts refusing them.
 *
 * Three ways this deliberately refuses:
 *
 *   - the presented token is invalid or expired  → 401, sign in again
 *   - the account is gone or deactivated         → 401
 *   - token_version moved on                     → 401, instant revocation
 *
 * The last one is why `ver` rides inside the token at all. Apps cannot check it
 * (they have no database); the issuer can, and does, here.
 */

export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }

  const current = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!current) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await grantStore().findByEmail(current.email);
  if (!user) {
    return clearAndReject("Account no longer active.");
  }

  if (user.tokenVersion !== current.ver) {
    return clearAndReject("Session was revoked.");
  }

  if (user.grants.length === 0) {
    return clearAndReject("Your account has no tools.");
  }

  const token = await mintSso(secret, {
    email: user.email,
    grants: user.grants,
    ver: user.tokenVersion,
  });

  const isSecure = new URL(request.url).protocol === "https:";
  /*
   * The person's roles as they are NOW (9 Oct). Every open tab calls this every
   * ten minutes and on coming back to it, so someone made an account manager on
   * Team access gets the Clients page without refreshing or signing in again —
   * and loses it the same way. Best effort: a failed read leaves the tab as is.
   */
  const viewer = await viewerRoles(user.email).catch(() => null);
  const response = NextResponse.json({
    ok: true,
    grants: user.grants,
    roles: viewer ? { accountManager: viewer.accountManager, salesperson: viewer.salesperson } : undefined,
  });

  response.cookies.set(
    SSO_COOKIE,
    token,
    ssoCookieOptions({ secure: isSecure, domain: process.env.SSO_COOKIE_DOMAIN }),
  );

  return response;
}

/**
 * Clear the cookie as well as refusing.
 *
 * Leaving a revoked token in place would let the holder keep using the other
 * apps for up to its remaining lifetime, since those verify offline and cannot
 * know it was withdrawn. Removing it here is what makes revocation immediate
 * rather than eventual.
 */
function clearAndReject(message: string) {
  const response = NextResponse.json({ error: message }, { status: 401 });
  response.cookies.set(SSO_COOKIE, "", {
    path: "/",
    maxAge: 0,
    domain: process.env.SSO_COOKIE_DOMAIN,
  });
  return response;
}
