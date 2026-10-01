import "server-only";

import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { osTable } from "@/lib/clients/os-db";
import { ALL_TOOLS } from "@/lib/bs-auth";
import { canSeePage, type RoleFlags } from "@/lib/workspace/nav";

import { isAdminUser } from "./admin-db";

/*
 * Who the signed-in person is, for deciding which pages they see (Eddy, 2 Oct):
 * admin, account manager (os_users.is_account_manager), salesperson (an
 * active os_salespeople record with their email), and their name — so Home
 * greets "Sam", not "Gabo075823532". Read on every page load; small queries.
 */
export interface Viewer extends RoleFlags {
  admin: boolean;
  /** The name on Team access, or null when none is set. */
  name: string | null;
}

export async function viewerRoles(email: string | null | undefined): Promise<Viewer> {
  const key = (email ?? "").trim().toLowerCase();
  if (!key) return { admin: false, accountManager: false, salesperson: false, name: null };
  const [admin, user, seller] = await Promise.all([
    isAdminUser(key),
    osTable("os_users").select("name, is_account_manager").eq("email", key).maybeSingle().then((r) => r.data as { name?: string | null; is_account_manager?: boolean } | null, () => null),
    osTable("os_salespeople").select("active").eq("email", key).maybeSingle().then((r) => r.data as { active?: boolean } | null, () => null),
  ]);
  return {
    admin,
    accountManager: user?.is_account_manager === true,
    salesperson: seller?.active === true,
    name: user?.name?.trim() || null,
  };
}

/**
 * Refuse an API call behind a page the caller may not see. Returns the
 * response to send, or null to carry on. The menu hides these pages; this is
 * what stops a typed URL or a direct call.
 */
export async function pageGuard(request: Request, pageId: string): Promise<NextResponse | null> {
  const session = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const v = await viewerRoles(session.email);
  if (canSeePage(pageId, v.admin, session.grants, ALL_TOOLS, v)) return null;
  return NextResponse.json({ error: "Forbidden", detail: "This page is not available for your role." }, { status: 403 });
}
