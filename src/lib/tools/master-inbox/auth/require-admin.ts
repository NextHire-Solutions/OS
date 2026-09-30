import { NextResponse } from "next/server";

import { requireSession, type SessionContext } from "@/lib/auth/workspace";
import { isAdminUser } from "@/lib/identity/admin-db";

/**
 * The session, or a 403 for anyone who is not a workspace admin.
 *
 * For the inbox's maintenance routes (dedupe, reclassify, backfills, forced
 * relabels, raw inspections). They were behind the plain inbox grant, so any
 * inbox user could rewrite message directions or delete messages workspace-wide.
 */
export async function requireAdminSession(): Promise<SessionContext | NextResponse> {
  const session = await requireSession();
  if (!(await isAdminUser(session.user.email))) {
    return NextResponse.json({ error: "Only workspace admins can run this." }, { status: 403 });
  }
  return session;
}
