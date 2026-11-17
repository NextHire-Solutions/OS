import { NextResponse } from "next/server";

import { requireSession, type SessionContext } from "@/lib/auth/workspace";
import { isAdminUser } from "@/lib/identity/admin-db";
import { holdsPage } from "@/lib/identity/named-pages";

/*
 * The brokerage hand-off's Settings page (Master Inbox › Settings › Brokerage hand-off) and every route behind it:
 * admins, and the people the page is opened to by name (identity/named-pages.ts — Amy, 18 Nov, on the user's word).
 * Whose emails can actually go out stays with us: the live list (OS_BROKERAGE_RELAY_LIVE_ONLY) is a server setting,
 * not on this page.
 */

/** Admins, and the people the Brokerage hand-off page is opened to by name. */
export async function canManageRelay(email: string | null | undefined): Promise<boolean> {
  return holdsPage(email, "brokerage-relay") || (await isAdminUser(email));
}

/** The session, or a 403 — for the routes behind the Brokerage hand-off page. */
export async function requireRelaySession(): Promise<SessionContext | NextResponse> {
  const session = await requireSession();
  if (!(await canManageRelay(session.user.email))) {
    return NextResponse.json({ error: "Only workspace admins can run this." }, { status: 403 });
  }
  return session;
}
