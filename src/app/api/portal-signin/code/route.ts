import { NextResponse, type NextRequest } from "next/server";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { signInWithCode } from "@/lib/portal-login/login";
import { clientIp, fromSignInPage, NO_STORE, REASON, sessionCookie, signInSecret } from "@/lib/portal-login/http";

/* POST /api/portal-signin/code { email, code } — the 6-digit code from the sign-in email → a 30-day session. */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!fromSignInPage(request.headers)) return NextResponse.json({ error: "Not available." }, { status: 403, headers: NO_STORE });
  const body = (await request.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.slice(0, 254) : "";
  const code = typeof body?.code === "string" ? body.code.slice(0, 20) : "";
  try {
    const r = await signInWithCode(createAdminSupabase(), { email, code, now: new Date(), secret: signInSecret(), userAgent: request.headers.get("user-agent"), ip: clientIp(request.headers) });
    if (!r.ok) return NextResponse.json({ error: REASON[r.reason] }, { status: 400, headers: NO_STORE });
    const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
    res.cookies.set(sessionCookie(r.session));
    console.info(JSON.stringify({ tag: "[portal-signin] signed in", by: "code" }));
    return res;
  } catch (e) {
    console.error(JSON.stringify({ tag: "[portal-signin] code failed", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return NextResponse.json({ error: "Signing in didn't work just now. Please try again." }, { status: 500, headers: NO_STORE });
  }
}
