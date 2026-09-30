import { NextResponse } from "next/server";

import { consentUrl, OAUTH_STATE_COOKIE } from "@/lib/tools/onboarding/google-oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    // A fresh, unguessable state per attempt, remembered in an httpOnly cookie
    // that only this browser holds. It used to be the constant "connect",
    // which the callback never checked.
    const state = crypto.randomUUID();
    const res = NextResponse.redirect(consentUrl(state));
    res.cookies.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: new URL(req.url).protocol === "https:",
      sameSite: "lax",
      path: "/api/tools/onboarding/auth/google",
      maxAge: 600,
    });
    return res;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "not configured" }, { status: 500 });
  }
}
