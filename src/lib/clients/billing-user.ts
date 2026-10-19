import "server-only";

import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { canSeeBillingTab } from "@/lib/clients/billing-access";
import { viewerRoles } from "@/lib/identity/viewer-roles";
import { sessionPageGrants } from "@/lib/workspace/switch-transition";

/*
 * Who may see a client's billing: an admin, or someone with the Clients page
 * switched on — the people the Clients screen is for. (9 Oct it was account
 * managers, who held that screen by role; 15 Oct the screen became a switch of
 * its own, and billing follows the screen.)
 *
 * The record's Stripe control. The Billing tab's routes use the narrower
 * billingTabUser below.
 */
export async function billingUser(request: Request): Promise<{ email: string; admin: boolean } | NextResponse> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const s = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!s?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const v = await viewerRoles(s.email);
  if (!v.admin && !sessionPageGrants(s, v).includes("roster")) {
    return NextResponse.json({ error: "Only admins and people with the Clients page can see or change billing." }, { status: 403 });
  }
  return { email: s.email.toLowerCase(), admin: v.admin };
}

/*
 * The Billing tab's own routes (19 Oct): admin@outreachify.io and Eddy only,
 * by name (billing-access.ts). Anyone else — signed in or not — gets a bare 404, so
 * the routes do not even say they exist. Not billingUser's rule: having the
 * Clients page is NOT enough here.
 */
export async function billingTabUser(request: Request): Promise<{ email: string } | NextResponse> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return new NextResponse(null, { status: 404 });
  const s = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!s?.email || !canSeeBillingTab(s.email)) return new NextResponse(null, { status: 404 });
  return { email: s.email.toLowerCase() };
}
