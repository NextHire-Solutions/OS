import { NextResponse } from "next/server";
import {
  mintSso,
  safeEqual,
  sha256Hex,
  ssoCookieOptions,
  SSO_COOKIE,
} from "@/lib/bs-auth";
import { grantStore } from "@/lib/identity/store";

export const dynamic = "force-dynamic";

/*
 * Sign-in. The only place in the whole system that mints a token.
 *
 * The cookie is scoped to the parent domain (.brokerstaffer.com) so every app
 * on a subdomain sees it as first-party — which is what lets an embedded pane
 * work with SameSite=Lax instead of the fragile SameSite=None arrangement a
 * cross-domain setup would force.
 *
 * SSO_COOKIE_DOMAIN is left unset in local development, because localhost has
 * no shared apex and setting a domain there silently drops the cookie.
 */

export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Auth is not configured on this deployment." },
      { status: 503 },
    );
  }

  let email = "";
  let password = "";
  try {
    const body = await request.json();
    email = typeof body?.email === "string" ? body.email : "";
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 },
    );
  }

  const user = await grantStore().findByEmail(email);

  // Hash the supplied password even when the email is unknown, so a
  // wrong-email response takes the same time as a wrong-password one and this
  // endpoint can't be used to enumerate who has an account.
  const supplied = await sha256Hex(password);
  const matched = user ? safeEqual(supplied, user.passwordHash) : false;

  if (!user || !matched) {
    return NextResponse.json(
      { error: "Incorrect email or password." },
      { status: 401 },
    );
  }

  // A real account with no tools is a configuration mistake worth naming
  // precisely. Otherwise it presents as a workspace that signs you in and then
  // shows an empty sidebar, which reads as a broken app rather than a missing
  // grant.
  if (user.grants.length === 0) {
    return NextResponse.json(
      {
        error:
          "Your account has no tools yet. Ask an admin to grant access in Team access.",
      },
      { status: 403 },
    );
  }

  const token = await mintSso(secret, {
    email: user.email,
    grants: user.grants,
    ver: user.tokenVersion,
  });

  const isSecure = new URL(request.url).protocol === "https:";
  const response = NextResponse.json({ ok: true, grants: user.grants });

  response.cookies.set(
    SSO_COOKIE,
    token,
    ssoCookieOptions({
      secure: isSecure,
      domain: process.env.SSO_COOKIE_DOMAIN,
    }),
  );

  return response;
}
