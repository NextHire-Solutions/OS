import { NextResponse, type NextRequest } from "next/server";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { signInWithLink } from "@/lib/portal-login/login";
import { clientIp, fromSignInPage, NO_STORE, REASON, sessionCookie } from "@/lib/portal-login/http";

/*
 * POST /api/portal-signin/confirm { t } — the link's own page, after the person
 * presses "Sign in". Not on opening the link: company mail scanners open links
 * by themselves, and a link spent by a scanner would be no link at all.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!fromSignInPage(request.headers)) return NextResponse.json({ error: "Not available." }, { status: 403, headers: NO_STORE });
  const body = (await request.json().catch(() => null)) as { t?: unknown } | null;
  const link = typeof body?.t === "string" ? body.t.slice(0, 200) : "";
  try {
    const r = await signInWithLink(createAdminSupabase(), { link, now: new Date(), userAgent: request.headers.get("user-agent"), ip: clientIp(request.headers) });
    if (!r.ok) return NextResponse.json({ error: REASON[r.reason] }, { status: 400, headers: NO_STORE });
    const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
    res.cookies.set(sessionCookie(r.session));
    console.info(JSON.stringify({ tag: "[portal-signin] signed in", by: "link" }));
    return res;
  } catch (e) {
    console.error(JSON.stringify({ tag: "[portal-signin] confirm failed", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return NextResponse.json({ error: "Signing in didn't work just now. Please try again." }, { status: 500, headers: NO_STORE });
  }
}
