import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { BillingControlError, readBilling, setBilling } from "@/lib/clients/billing-control";
import { osTable } from "@/lib/clients/os-db";
import { viewerRoles } from "@/lib/identity/viewer-roles";
import { parseAmount, parseEvery } from "@/lib/clients/payment-link-plan";
import { cancelLink, createLink, openLinks, PaymentLinkError, settle } from "@/lib/clients/payment-links";
import { getAccountBilling, getStripeSnapshot } from "@/lib/clients/billing-account";
import { clientsChanged } from "@/lib/clients/after-change";
import { blockingEnabled, blockThreshold, openPortalBlocks } from "@/lib/clients/billing-watch";

/*
 * A client's Stripe billing, from its record. Admins and account managers
 * (9 Oct — they hold the Clients screen, so they pause and resume billing):
 * both see it and pause or resume it. Linking Stripe customers and payment
 * links — creating money movements — stay with admins.
 *
 *   GET   ?clientId=…                         live state from Stripe, every subscription the client
 *                                             owns (billing-model.ts), and open payment links
 *   POST  { clientId, action: "pause" | "resume", subscriptionId? }   any subscription the client OWNS
 *   POST  { clientId, action: "link", stripeId }                      a customer (cus_) or subscription (sub_)
 *   POST  { clientId, action: "unlink" | "exclude", customerId, subscriptionId? }
 *   POST  { clientId, action: "create_link", amount, every }   a payment link for a new subscription
 *   POST  { clientId, action: "cancel_link", linkId }
 *
 * The subscription is always the one on the client's record — never taken
 * from the request — so a request cannot pause someone else's billing.
 */
export const dynamic = "force-dynamic";

/** Who may use billing: an admin, or an account manager — the people the Clients screen is for. */
async function billingUser(request: Request): Promise<{ email: string; admin: boolean } | NextResponse> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const s = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!s?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const v = await viewerRoles(s.email);
  if (!v.admin && !v.accountManager) {
    return NextResponse.json({ error: "Only admins and account managers can see or change billing." }, { status: 403 });
  }
  return { email: s.email.toLowerCase(), admin: v.admin };
}

/** Pausing and resuming: admins and account managers. Everything else here: admins. */
const FOR_ACCOUNT_MANAGERS = new Set(["pause", "resume"]);

async function subscriptionOf(clientId: string): Promise<{ name: string; sub: string | null } | null> {
  const { data } = await osTable("os_clients").select("name, stripe_subscription_id").eq("id", clientId).maybeSingle();
  const row = data as { name?: string; stripe_subscription_id?: string | null } | null;
  return row ? { name: row.name ?? "", sub: row.stripe_subscription_id ?? null } : null;
}

export async function GET(request: Request) {
  const who = await billingUser(request);
  if (who instanceof NextResponse) return who;
  // The admin-only controls (links, payment links) are drawn only for admins.
  const canManage = who.admin;
  const clientId = new URL(request.url).searchParams.get("clientId") ?? "";
  if (!clientId || !(await subscriptionOf(clientId))) return NextResponse.json({ error: "No such client" }, { status: 404 });
  // A link paid since the last look becomes this client's subscription first.
  await settle(clientId);
  const c = (await subscriptionOf(clientId))!;
  const links = await openLinks(clientId);
  // Every subscription and customer the client owns, across cards and shared customers (6 Oct).
  let account = null, linksReady = false, accountError: string | null = null;
  try {
    const a = await getAccountBilling();
    account = a.byClient.get(clientId) ?? null;
    linksReady = a.linksReady;
  } catch (e) {
    accountError = e instanceof Error ? e.message : "Stripe could not be read";
  }
  // Its portal held (or, in dry run, would be) for an unpaid invoice.
  const block = (await openPortalBlocks()).find((b) => b.clientId === clientId) ?? null;
  const portalBlock = { block, enabled: blockingEnabled(), afterAttempts: blockThreshold() };
  const canCreateLinks = canManage && links !== null;
  if (!c.sub) return NextResponse.json({ linked: false, links, canCreateLinks, canManage, account, linksReady, accountError, portalBlock });
  try {
    return NextResponse.json({ linked: true, billing: await readBilling(c.sub), links, canCreateLinks, canManage, account, linksReady, accountError, portalBlock });
  } catch (e) {
    return NextResponse.json({ linked: true, links, canManage, account, linksReady, error: e instanceof Error ? e.message : "Stripe could not be read" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const who = await billingUser(request);
  if (who instanceof NextResponse) return who;
  const me = who.email;
  const body = (await request.json().catch(() => null)) as {
    clientId?: unknown; action?: unknown; amount?: unknown; every?: unknown; linkId?: unknown;
    subscriptionId?: unknown; customerId?: unknown; stripeId?: unknown;
  } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const act = body?.action;
  if (!clientId || !["pause", "resume", "create_link", "cancel_link", "link", "unlink", "exclude"].includes(String(act))) {
    return NextResponse.json({ error: "clientId and action (pause, resume, create_link, cancel_link, link, unlink or exclude) are required." }, { status: 400 });
  }
  if (!who.admin && !FOR_ACCOUNT_MANAGERS.has(String(act))) {
    return NextResponse.json({ error: "Only admins can link Stripe accounts or create and cancel payment links." }, { status: 403 });
  }
  const c = await subscriptionOf(clientId);
  if (!c) return NextResponse.json({ error: "No such client" }, { status: 404 });

  /* ---- which Stripe customers and subscriptions are this client's (0030) ---- */
  if (act === "link" || act === "unlink" || act === "exclude") {
    const snap = await getStripeSnapshot();
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    try {
      if (act === "link") {
        const id = str(body?.stripeId);
        const sub = id.startsWith("sub_") ? snap.subscriptions.find((x) => x.id === id) : null;
        const cus = id.startsWith("cus_") ? snap.customers.find((x) => x.id === id) : null;
        if (!sub && !cus) return NextResponse.json({ error: `${id || "That id"} is not a customer (cus_…) or subscription (sub_…) in Stripe.` }, { status: 400 });
        const row = { os_client_id: clientId, stripe_customer_id: sub ? sub.customer : cus!.id, stripe_subscription_id: sub ? sub.id : null, created_by: me };
        // Re-linking something previously excluded replaces the exclusion.
        await osTable("os_client_stripe_links").delete().eq("os_client_id", clientId).eq("stripe_customer_id", row.stripe_customer_id).eq("excluded", true);
        const { error } = await osTable("os_client_stripe_links").insert(row);
        if (error) {
          const msg = /duplicate|unique/i.test(error.message) ? "That subscription is already linked to a client — unlink it there first."
            : /os_client_stripe_links/.test(error.message) ? "Linking needs migrations/0030_billing_profile.sql run first." : error.message;
          return NextResponse.json({ error: msg }, { status: 400 });
        }
        console.log(`[billing] ${me} linked ${id} to ${c.name}`);
      } else {
        const customerId = str(body?.customerId);
        const subscriptionId = str(body?.subscriptionId) || null;
        if (!customerId) return NextResponse.json({ error: "customerId is required." }, { status: 400 });
        let q = osTable("os_client_stripe_links").delete().eq("os_client_id", clientId).eq("stripe_customer_id", customerId);
        q = subscriptionId ? q.eq("stripe_subscription_id", subscriptionId) : q.is("stripe_subscription_id", null);
        const { error: delErr } = await q;
        if (delErr) return NextResponse.json({ error: /os_client_stripe_links/.test(delErr.message) ? "Needs migrations/0030_billing_profile.sql run first." : delErr.message }, { status: 400 });
        if (act === "exclude") {
          const { error } = await osTable("os_client_stripe_links").insert({ os_client_id: clientId, stripe_customer_id: customerId, stripe_subscription_id: subscriptionId, excluded: true, created_by: me });
          if (error) return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.log(`[billing] ${me} ${act === "exclude" ? "excluded" : "unlinked"} ${subscriptionId ?? customerId} from ${c.name}`);
      }
      clientsChanged();
      const a = await getAccountBilling();
      return NextResponse.json({ ok: true, account: a.byClient.get(clientId) ?? null, linksReady: a.linksReady });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change the link" }, { status: 502 });
    }
  }

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
      // Fail CLOSED: if Stripe cannot say whether the current subscription is
      // live, do not risk a second one. `null` would read as "none".
      let current: Awaited<ReturnType<typeof readBilling>> | null = null;
      if (c.sub) {
        try { current = await readBilling(c.sub); } catch (e) {
          return NextResponse.json({ error: `Stripe could not confirm the current subscription (${e instanceof Error ? e.message : "no answer"}). Try again in a minute.` }, { status: 502 });
        }
      }
      const link = await createLink(clientId, amount.cents, every, me, current);
      console.log(`[billing] ${me} created a payment link for ${c.name}: ${link.label}`);
      return NextResponse.json({ ok: true, link });
    } catch (e) {
      const status = e instanceof PaymentLinkError || e instanceof BillingControlError ? 400 : 502;
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not create the payment link" }, { status });
    }
  }
  const action = act as "pause" | "resume";
  /*
   * Which subscription: one the request names, but only if this client OWNS it
   * (billing-model.ts) — a request still cannot pause someone else's billing.
   * Without one, the subscription on the record, as before.
   */
  let target = c.sub;
  const asked = typeof body?.subscriptionId === "string" ? body.subscriptionId : "";
  if (asked) {
    const owned = (await getAccountBilling()).byClient.get(clientId)?.subscriptions.some((s) => s.id === asked) ?? false;
    if (!owned) return NextResponse.json({ error: "That subscription is not this client's." }, { status: 400 });
    target = asked;
  }
  if (!target) return NextResponse.json({ error: "This client is not linked to a Stripe subscription." }, { status: 400 });
  try {
    const billing = await setBilling(target, action);
    console.log(`[billing] ${me} ${action}d billing for ${c.name} (${target})`);
    getStripeSnapshot.invalidate();
    clientsChanged();
    return NextResponse.json({ ok: true, billing });
  } catch (e) {
    const status = e instanceof BillingControlError ? 400 : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change billing" }, { status });
  }
}
