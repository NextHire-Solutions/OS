import { NextResponse } from "next/server";

import { requireSession, type SessionContext } from "@/lib/auth/workspace";
import { isAdminUser } from "@/lib/identity/admin-db";
import { holdsPage } from "@/lib/identity/named-pages";

/** Admins, and the people the Reply agent page is opened to by name (identity/named-pages.ts). */
export async function canUseReplyAgent(email: string | null | undefined): Promise<boolean> {
  return holdsPage(email, "reply-agent") || (await isAdminUser(email));
}

/** The session, or a 403 — for the routes behind the Reply agent page. */
export async function requireReplyAgentSession(): Promise<SessionContext | NextResponse> {
  const session = await requireSession();
  if (!(await canUseReplyAgent(session.user.email))) {
    return NextResponse.json({ error: "Only workspace admins can run this." }, { status: 403 });
  }
  return session;
}
