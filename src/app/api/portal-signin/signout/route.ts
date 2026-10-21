import { NextResponse, type NextRequest } from "next/server";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { endSession } from "@/lib/portal-login/login";
import { fromSignInPage, NO_STORE, PORTAL_COOKIE } from "@/lib/portal-login/http";

/* POST /api/portal-signin/signout — this browser's session ends, and its cookie goes. */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!fromSignInPage(request.headers)) return NextResponse.json({ error: "Not available." }, { status: 403, headers: NO_STORE });
  const session = request.cookies.get(PORTAL_COOKIE)?.value;
  if (session) {
    try {
      await endSession(createAdminSupabase(), session, new Date());
    } catch (e) {
      console.error(JSON.stringify({ tag: "[portal-signin] signout failed", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    }
  }
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  res.cookies.set({ name: PORTAL_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}
