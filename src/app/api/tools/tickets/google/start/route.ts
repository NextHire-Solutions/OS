import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { publicOrigin } from "@/lib/mcp/oauth";
import { oauthConfig, tokenKeySet } from "@/lib/tools/tickets/config";
import { consentUrl } from "@/lib/tools/tickets/gmail-api";
import { ticketsViewer } from "@/lib/tools/tickets/route-auth";

/*
 * GET /api/tools/tickets/google/start — off to Google's consent screen to connect the viewer's Gmail (read-only).
 * A random state goes in a short-lived cookie scoped to the callback, so the code can only come back to the
 * browser that started (otherwise someone could connect THEIR mailbox in a teammate's name: login CSRF).
 */
export const dynamic = "force-dynamic";

const STATE_COOKIE = "os_tickets_oauth";

export async function GET(request: NextRequest) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  const cfg = oauthConfig();
  const back = `${publicOrigin()}/tickets/inboxes`;
  if (!cfg || !tokenKeySet()) return NextResponse.redirect(`${back}?error=${encodeURIComponent("Google sign-in for Tickets isn't set up on the OS yet.")}`);
  const state = randomUUID();
  const res = NextResponse.redirect(consentUrl(cfg, state, viewer.email));
  res.cookies.set(STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/tools/tickets/google", maxAge: 600 });
  return res;
}
