import { NextResponse, type NextRequest } from "next/server";

import { publicOrigin } from "@/lib/mcp/oauth";
import { oauthConfig } from "@/lib/tools/tickets/config";
import { exchangeCode } from "@/lib/tools/tickets/gmail-api";
import { ticketsViewer } from "@/lib/tools/tickets/route-auth";
import { forgetAccessToken } from "@/lib/tools/tickets/runner";
import { saveMailbox } from "@/lib/tools/tickets/service";

/*
 * GET /api/tools/tickets/google/callback?code=…&state=… — Google sends the teammate back here after consent.
 * The state must match the cookie set when THIS browser started; then the code becomes a refresh token, stored
 * encrypted, and the first fill starts in the background. Lands back on Connected inboxes either way.
 */
export const dynamic = "force-dynamic";

const STATE_COOKIE = "os_tickets_oauth";

export async function GET(request: NextRequest) {
  const back = `${publicOrigin()}/tickets/inboxes`;
  const done = (qs: string) => {
    const res = NextResponse.redirect(`${back}?${qs}`);
    res.cookies.set(STATE_COOKIE, "", { path: "/api/tools/tickets/google", maxAge: 0 });
    return res;
  };
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return done(`error=${encodeURIComponent("Sign in to the OS, then press Connect again.")}`);
  const p = request.nextUrl.searchParams;
  const gErr = p.get("error");
  if (gErr) {
    const why = gErr === "access_denied"
      ? "Google access wasn't given, so nothing was connected."
      : /admin_policy|org_internal|unauthorized_client/.test(gErr)
        ? "Your Google Workspace admin is blocking this app from reading Gmail. An admin can allow it: Google Admin console > Security > Access and data control > API controls > Manage third-party app access > Add app > search for the Tickets Client ID > Trusted. Then press Connect again."
        : `Google refused the connection (${gErr}). Press Connect again; if it keeps happening, tell an admin.`;
    return done(`error=${encodeURIComponent(why)}`);
  }
  const expected = request.cookies.get(STATE_COOKIE)?.value;
  const state = p.get("state");
  const code = p.get("code");
  if (!expected || !state || state !== expected) return done(`error=${encodeURIComponent("That connect link was not started here. Press Connect again.")}`);
  if (!code) return done(`error=${encodeURIComponent("Google sent no code back. Press Connect again.")}`);
  const cfg = oauthConfig();
  if (!cfg) return done(`error=${encodeURIComponent("Google sign-in for Tickets isn't set up on the OS yet.")}`);
  try {
    const t = await exchangeCode(cfg, code);
    await saveMailbox({ email: t.email, name: t.name, refreshToken: t.refreshToken, scope: t.scope, connectedBy: viewer.email });
    forgetAccessToken(t.email);
    void import("@/lib/tools/tickets/runner").then((r) => r.runTicketsSync()).catch(() => {});
    return done(`connected=${encodeURIComponent(t.email)}`);
  } catch (e) {
    return done(`error=${encodeURIComponent(e instanceof Error ? e.message : "Connecting failed")}`);
  }
}
