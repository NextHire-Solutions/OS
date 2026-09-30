import { NextResponse } from "next/server";

import { appBaseUrl } from "@/lib/tools/onboarding/env";
import { connectFromCode, OAUTH_STATE_COOKIE } from "@/lib/tools/onboarding/google-oauth";

/*
 * Google redirects here after consent with ?code=... — exchange it and store the
 * refresh token. The tool's `app/api/auth/google/callback/route.ts`, landing on
 * the OS's own settings screen (/onboarding/settings) instead of /settings.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const settings = `${appBaseUrl()}/onboarding/settings`;

  if (error) return NextResponse.redirect(`${settings}?error=${encodeURIComponent(error)}`);
  if (!code) return NextResponse.redirect(`${settings}?error=missing_code`);

  /*
   * The code must come back to the browser that started THIS connect. Without
   * the check, anyone could finish Google's consent with their own account
   * and send a signed-in staff member the callback link: the company mailbox
   * row would be replaced with theirs (login CSRF).
   */
  const expected = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))?.slice(OAUTH_STATE_COOKIE.length + 1);
  const state = url.searchParams.get("state");
  if (!expected || !state || state !== decodeURIComponent(expected)) {
    return NextResponse.redirect(`${settings}?error=${encodeURIComponent("That connect link was not started here. Press Connect Gmail again.")}`);
  }

  const done = (to: string) => {
    const res = NextResponse.redirect(to);
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/api/tools/onboarding/auth/google", maxAge: 0 });
    return res;
  };
  try {
    const { email } = await connectFromCode(code);
    return done(`${settings}?connected=${encodeURIComponent(email)}`);
  } catch (e) {
    return done(`${settings}?error=${encodeURIComponent(e instanceof Error ? e.message : "exchange_failed")}`);
  }
}
