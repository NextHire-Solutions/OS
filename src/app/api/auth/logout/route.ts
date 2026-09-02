import { NextResponse } from "next/server";
import { SSO_COOKIE } from "@/lib/bs-auth";

export const dynamic = "force-dynamic";

/*
 * Clears the session and returns to /login.
 *
 * The Location header is RELATIVE on purpose. Behind Railway's proxy a route
 * handler's `request.url` is the *internal* container origin
 * (http://localhost:8080/...), not the public hostname — so
 * `new URL("/login", request.url)` produced a redirect to
 * https://localhost:8080/login and logging out landed on a dead page.
 *
 * A relative Location sidesteps host detection entirely: the browser resolves
 * it against whatever origin it actually used. That is more robust than
 * reading x-forwarded-host, which depends on the proxy being configured to
 * send it. NextResponse.redirect() insists on an absolute URL, so the response
 * is constructed directly.
 *
 * Note the edge proxy (src/proxy.ts) is NOT affected — middleware runs before
 * the internal hop and already emits a relative Location.
 */
export function POST() {
  const response = new NextResponse(null, {
    status: 303, // 303 so the browser turns this POST into a GET
    headers: { Location: "/login" },
  });

  // Must be cleared with the SAME domain it was set with. A cookie set on
  // .brokerstaffer.com and cleared without a domain is treated as a different
  // cookie: sign-out appears to work, the session survives, and the user is
  // still signed in to all four apps.
  response.cookies.set(SSO_COOKIE, "", {
    path: "/",
    maxAge: 0,
    domain: process.env.SSO_COOKIE_DOMAIN,
  });

  return response;
}
