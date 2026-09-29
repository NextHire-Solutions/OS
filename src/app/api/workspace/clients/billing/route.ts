import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { BillingControlError, readBilling, setBilling } from "@/lib/clients/billing-control";
import { osTable } from "@/lib/clients/os-db";
import { isAdminUser } from "@/lib/identity/admin-db";

/*
 * A client's Stripe billing, from its record. ADMINS ONLY — both reading it
 * and changing it: it is money, and the amount is not everyone's business.
 *
 *   GET   ?clientId=…                         live state from Stripe
 *   POST  { clientId, action: "pause" | "resume" }
 *
 * The subscription is always the one on the client's record — never taken
 * from the request — so a request cannot pause someone else's billing.
 */
export const dynamic = "force-dynamic";

async function adminEmail(request: Request): Promise<string | NextResponse> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const s = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!s?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isAdminUser(s.email))) return NextResponse.json({ error: "Only admins can see or change billing." }, { status: 403 });
  return s.email.toLowerCase();
}

async function subscriptionOf(clientId: string): Promise<{ name: string; sub: string | null } | null> {
  const { data } = await osTable("os_clients").select("name, stripe_subscription_id").eq("id", clientId).maybeSingle();
  const row = data as { name?: string; stripe_subscription_id?: string | null } | null;
  return row ? { name: row.name ?? "", sub: row.stripe_subscription_id ?? null } : null;
}

export async function GET(request: Request) {
  const me = await adminEmail(request);
  if (me instanceof NextResponse) return me;
  const clientId = new URL(request.url).searchParams.get("clientId") ?? "";
  const c = clientId ? await subscriptionOf(clientId) : null;
  if (!c) return NextResponse.json({ error: "No such client" }, { status: 404 });
  if (!c.sub) return NextResponse.json({ linked: false });
  try {
    return NextResponse.json({ linked: true, billing: await readBilling(c.sub) });
  } catch (e) {
    return NextResponse.json({ linked: true, error: e instanceof Error ? e.message : "Stripe could not be read" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const me = await adminEmail(request);
  if (me instanceof NextResponse) return me;
  const body = (await request.json().catch(() => null)) as { clientId?: unknown; action?: unknown } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const action = body?.action === "pause" || body?.action === "resume" ? body.action : null;
  if (!clientId || !action) return NextResponse.json({ error: "clientId and action (pause or resume) are required." }, { status: 400 });
  const c = await subscriptionOf(clientId);
  if (!c) return NextResponse.json({ error: "No such client" }, { status: 404 });
  if (!c.sub) return NextResponse.json({ error: "This client is not linked to a Stripe subscription." }, { status: 400 });
  try {
    const billing = await setBilling(c.sub, action);
    console.log(`[billing] ${me} ${action}d billing for ${c.name} (${c.sub})`);
    return NextResponse.json({ ok: true, billing });
  } catch (e) {
    const status = e instanceof BillingControlError ? 400 : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change billing" }, { status });
  }
}
