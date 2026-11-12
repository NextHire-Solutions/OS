import { NextResponse } from "next/server";

import { canSeeBillingTab } from "@/lib/clients/billing-access";
import { BillingControlError, readBilling, setBilling } from "@/lib/clients/billing-control";
import { billingUser } from "@/lib/clients/billing-user";
import { osTable } from "@/lib/clients/os-db";
import { parseAmount, parseEvery } from "@/lib/clients/payment-link-plan";
import { cancelLink, createLink, openLinks, PaymentLinkError, settle } from "@/lib/clients/payment-links";
import { getAccountBilling, getStripeSnapshot } from "@/lib/clients/billing-account";
import { foundByEmail, type FoundByEmail } from "@/lib/clients/billing-model";
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
 *   (A customer's invoice email: billing/email, the Billing tab's people only; GET says canChangeEmail.)
 *
 * The subscription is always the one on the client's record — never taken
 * from the request — so a request cannot pause someone else's billing.
 */
export const dynamic = "force-dynamic";

/* Who may use billing: billing-user.ts — admins, and people with the Clients page. */

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
  // Found in Stripe by email, counted only once a person confirms it (6 Nov; billing-model.ts emailSuggestions).
  let found: FoundByEmail[] = [];
  try {
    const a = await getAccountBilling();
    account = a.byClient.get(clientId) ?? null;
    linksReady = a.linksReady;
    // A problem here hides only the found list, never the client's billing.
    try { found = foundByEmail(a.snapshot, a.suggestions, clientId); } catch (e) { console.error("[billing] found by email:", e instanceof Error ? e.message : e); }
  } catch (e) {
    accountError = e instanceof Error ? e.message : "Stripe could not be read";
  }
  // Its portal held (or, in dry run, would be) for an unpaid invoice.
  const block = (await openPortalBlocks()).find((b) => b.clientId === clientId) ?? null;
  const portalBlock = { block, enabled: blockingEnabled(), afterAttempts: blockThreshold() };
  const canCreateLinks = canManage && links !== null;
  // Changing where a customer's invoices go (12 Nov, billing/email): the Billing tab's people only, decided here, by name.
  const canChangeEmail = canSeeBillingTab(who.email);
  if (!c.sub) return NextResponse.json({ linked: false, links, canCreateLinks, canManage, canChangeEmail, account, found, linksReady, accountError, portalBlock });
  try {
    return NextResponse.json({ linked: true, billing: await readBilling(c.sub), links, canCreateLinks, canManage, canChangeEmail, account, found, linksReady, accountError, portalBlock });
  } catch (e) {
    return NextResponse.json({ linked: true, links, canManage, canChangeEmail, account, found, linksReady, error: e instanceof Error ? e.message : "Stripe could not be read" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const who = await billingUser(request);
  if (who instanceof NextResponse) return who;
  const me = who.email;
  const body = (await request.json().catch(() => null)) as {
    clientId?: unknown; action?: unknown; amount?: unknown; every?: unknown; linkId?: unknown;
    subscriptionId?: unknown; customerId?: unknown; stripeId?: unknown; confirmFound?: unknown;
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
        /*
         * "Yes, it's theirs" on a customer found by email (6 Nov): only while it is still found for this client — nobody
         * has linked it elsewhere or said Not theirs since the tab was opened.
         */
        if (body?.confirmFound === true) {
          const now = await getAccountBilling();
          if (!now.suggestionsReady) {
            return NextResponse.json({ error: "Couldn't check this customer just now (the portal sign-in lists or Stripe links couldn't be read). Nothing was linked — try again in a minute." }, { status: 503 });
          }
          if (!cus || !now.suggestions.some((x) => x.clientId === clientId && x.customerId === cus.id)) {
            return NextResponse.json({ error: "This customer has changed since the page was opened (linked or ruled out elsewhere). Nothing was linked." }, { status: 409 });
          }
        }
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
        /*
         * The record's own customer (its Stripe Customer ID, or its subscription's customer) also linked: an exclusion
         * would take the record's own subscription off the client too (6 Nov review). It is the record's to change.
         */
        if (act === "exclude" && !subscriptionId) {
          const { data: rec } = await osTable("os_clients").select("stripe_customer_id, stripe_subscription_id").eq("id", clientId).maybeSingle();
          const r = rec as { stripe_customer_id?: string | null; stripe_subscription_id?: string | null } | null;
          const recordCustomers = [r?.stripe_customer_id, r?.stripe_subscription_id ? snap.subscriptions.find((x) => x.id === r.stripe_subscription_id)?.customer : null];
          if (recordCustomers.includes(customerId)) {
            return NextResponse.json({ error: `This customer is on ${c.name}'s record (its Stripe Customer ID or Subscription ID), so it stays theirs. To take it off, change those fields on the Record. Nothing was changed.` }, { status: 409 });
          }
        }
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
      // It is saved: a problem reading it back must not read as a failure to save (the page then reloads it).
      try {
        const a = await getAccountBilling();
        let found: FoundByEmail[] = [];
        try { found = foundByEmail(a.snapshot, a.suggestions, clientId); } catch (e) { console.error("[billing] found by email:", e instanceof Error ? e.message : e); }
        return NextResponse.json({ ok: true, account: a.byClient.get(clientId) ?? null, found, linksReady: a.linksReady });
      } catch (e) {
        console.error("[billing] saved, but reading it back failed:", e instanceof Error ? e.message : e);
        return NextResponse.json({ ok: true });
      }
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
