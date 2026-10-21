import { NextResponse, after, type NextRequest } from "next/server";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { requestSignIn, type SignInEmail } from "@/lib/portal-login/login";
import { mayEmail, sendSignInEmail } from "@/lib/portal-login/mail";
import { clientIp, confirmBase, fromSignInPage, NO_STORE, signInSecret } from "@/lib/portal-login/http";

/*
 * POST /api/portal-signin/request { email } — "Send link to log in" (21 Oct).
 *
 * The answer is the same for every address, at once: the work is done after
 * it (Next's after()), so not even the time taken says whether an address is
 * on a portal's list. Only a listed address is sent anything (portal-login/
 * login.ts), and while sign-in is closed only our own test address
 * (portal-login/mail.ts).
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!fromSignInPage(request.headers)) return NextResponse.json({ error: "Not available." }, { status: 403, headers: NO_STORE });
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.slice(0, 254) : "";
  const ip = clientIp(request.headers);
  after(async () => {
    if (!mayEmail(email)) return;
    try {
      const mails: SignInEmail[] = [];
      const r = await requestSignIn(createAdminSupabase(), { email, ip, now: new Date(), secret: signInSecret(), linkBase: confirmBase() }, async (m) => { mails.push(m); });
      for (const m of mails) await sendSignInEmail(m);
      console.info(JSON.stringify({ tag: "[portal-signin] request", sent: r.sent, why: r.why ?? null }));
    } catch (e) {
      console.error(JSON.stringify({ tag: "[portal-signin] request failed", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    }
  });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
