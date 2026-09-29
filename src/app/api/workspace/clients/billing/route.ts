import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { BillingControlError, readBilling, setBilling } from "@/lib/clients/billing-control";
import { osTable } from "@/lib/clients/os-db";
import { isAdminUser } from "@/lib/identity/admin-db";
import { parseAmount, parseEvery } from "@/lib/clients/payment-link-plan";
import { cancelLink, createLink, openLinks, PaymentLinkError, settle } from "@/lib/clients/payment-links";

/*
 * A client's Stripe billing, from its record. ADMINS ONLY — both reading it
 * and changing it: it is money, and the amount is not everyone's business.
 *
 *   GET   ?clientId=…                         live state from Stripe, and open payment links
 *   POST  { clientId, action: "pause" | "resume" }
 *   POST  { clientId, action: "create_link", amount, every }   a payment link for a new subscription
 *   POST  { clientId, action: "cancel_link", linkId }
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
  if (!clientId || !(await subscriptionOf(clientId))) return NextResponse.json({ error: "No such client" }, { status: 404 });
  // A link paid since the last look becomes this client's subscription first.
  await settle(clientId);
  const c = (await subscriptionOf(clientId))!;
  const links = await openLinks(clientId);
  if (!c.sub) return NextResponse.json({ linked: false, links, canCreateLinks: links !== null });
  try {
    return NextResponse.json({ linked: true, billing: await readBilling(c.sub), links, canCreateLinks: links !== null });
  } catch (e) {
    return NextResponse.json({ linked: true, links, error: e instanceof Error ? e.message : "Stripe could not be read" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const me = await adminEmail(request);
  if (me instanceof NextResponse) return me;
  const body = (await request.json().catch(() => null)) as { clientId?: unknown; action?: unknown; amount?: unknown; every?: unknown; linkId?: unknown } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const act = body?.action;
  if (!clientId || !["pause", "resume", "create_link", "cancel_link"].includes(String(act))) {
    return NextResponse.json({ error: "clientId and action (pause, resume, create_link or cancel_link) are required." }, { status: 400 });
  }
  const c = await subscriptionOf(clientId);
  if (!c) return NextResponse.json({ error: "No such client" }, { status: 404 });

  if (act === "create_link" || act === "cancel_link") {
    try {
      if (act === "cancel_link") {
        await cancelLink(clientId, typeof body?.linkId === "string" ? body.linkId : "");
        console.log(`[billing] ${me} cancelled a payment link for ${c.name}`);
        return NextResponse.json({ ok: true });
      }
      const amount = parseAmount(body?.amount);
      if ("error" in amount) return NextResponse.json({ error: amount.error }, { status: 400 });
      const every = parseEvery(body?.every);
      if (!every) return NextResponse.json({ error: "Choose how often: every 14 days, every 28 days or monthly." }, { status: 400 });
      const current = c.sub ? await readBilling(c.sub).catch(() => null) : null;
      const link = await createLink(clientId, amount.cents, every, me, current);
      console.log(`[billing] ${me} created a payment link for ${c.name}: ${link.label}`);
      return NextResponse.json({ ok: true, link });
    } catch (e) {
      const status = e instanceof PaymentLinkError || e instanceof BillingControlError ? 400 : 502;
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not create the payment link" }, { status });
    }
  }
  const action = act as "pause" | "resume";
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
