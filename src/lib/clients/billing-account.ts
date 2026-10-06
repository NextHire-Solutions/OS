import "server-only";

import { stripeGet } from "@/lib/commissions/stripe-payments";
import { osTable } from "@/lib/clients/os-db";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import {
  billingTotals,
  buildBilling,
  upcomingCharges,
  type AccountSnapshot,
  type BillingClientRef,
  type ClientBilling,
  type StripeLinkRow,
} from "./billing-model";

/*
 * The whole Stripe account, read once and cached (6 Oct) — the input to
 * billing-model.ts. Read-only: every call here is a GET.
 *
 * One read of everything (≈75 customers, 60 subscriptions, 450 charges, 350
 * invoices) takes ~20s, so it is cached ten minutes and served stale for up
 * to an hour while it refreshes behind. Money moves on a 14-day cadence.
 *
 * This account is on Stripe's newer API: a charge no longer names its invoice
 * and an invoice no longer names its charge. The join is
 * charge.payment_intent → invoice_payments → invoice → subscription.
 */

async function json<T>(url: string): Promise<T> {
  const res = await stripeGet(url);
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !body) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
  return body;
}

async function all<T extends { id: string }>(path: string, max = 60): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < max; page++) {
    const q = new URLSearchParams(path.includes("?") ? path.split("?")[1] : "");
    q.set("limit", "100");
    if (after) q.set("starting_after", after);
    const body = await json<{ data: T[]; has_more: boolean }>(`https://api.stripe.com/v1/${path.split("?")[0]}?${q}`);
    out.push(...body.data);
    if (!body.has_more || !body.data.length) break;
    after = body.data[body.data.length - 1].id;
  }
  return out;
}

type RawSub = {
  id: string; customer: string; status: string; created: number; canceled_at: number | null;
  current_period_end?: number;
  pause_collection: { behavior: string; resumes_at: number | null } | null;
  discount?: { coupon?: { percent_off?: number | null } } | null;
  discounts?: Array<{ coupon?: { percent_off?: number | null } } | string>;
  metadata?: Record<string, string>;
  items: { data: Array<{ quantity?: number; current_period_end?: number; price?: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } } }> };
};
type RawInvoice = {
  id: string; customer: string; status: string; attempt_count: number; next_payment_attempt: number | null;
  amount_due: number; amount_remaining: number; created: number; number: string | null; hosted_invoice_url: string | null;
  subscription?: string | null; parent?: { subscription_details?: { subscription?: string | null } | null } | null;
};
type RawCharge = { id: string; customer: string | null; status: string; amount: number; amount_refunded: number; created: number; payment_intent: string | null; failure_message: string | null };
type RawInvoicePayment = { id: string; invoice: string; payment?: { payment_intent?: string | null } };

async function loadSnapshot(): Promise<AccountSnapshot> {
  const [customers, subs, charges, invoices, payments] = await Promise.all([
    all<{ id: string; name: string | null; email: string | null; created: number }>("customers"),
    all<RawSub>("subscriptions?status=all"),
    all<RawCharge>("charges"),
    all<RawInvoice>("invoices"),
    all<RawInvoicePayment>("invoice_payments"),
  ]);
  const invoiceSub = new Map(invoices.map((i) => [i.id, i.parent?.subscription_details?.subscription ?? i.subscription ?? null]));
  const piInvoice = new Map(payments.filter((p) => p.payment?.payment_intent).map((p) => [p.payment!.payment_intent!, p.invoice]));
  return {
    customers: customers.map((c) => ({ id: c.id, name: c.name, email: c.email, created: c.created })),
    subscriptions: subs.map((s) => {
      const off = s.discount?.coupon?.percent_off
        ?? s.discounts?.map((d) => (typeof d === "string" ? null : d.coupon?.percent_off)).find((v) => typeof v === "number") ?? 0;
      return {
        id: s.id, customer: s.customer, status: s.status, created: s.created, canceledAt: s.canceled_at,
        pause: s.pause_collection ? { behavior: s.pause_collection.behavior, resumesAt: s.pause_collection.resumes_at } : null,
        periodEnd: s.items.data[0]?.current_period_end ?? s.current_period_end ?? null,
        items: s.items.data.map((it) => ({
          amount: (it.price?.unit_amount ?? 0) / 100,
          interval: it.price?.recurring?.interval ?? "month",
          intervalCount: it.price?.recurring?.interval_count ?? 1,
          quantity: it.quantity ?? 1,
        })),
        percentOff: off ?? 0,
        osClientId: s.metadata?.os_client_id ?? null,
      };
    }),
    charges: charges.map((c) => {
      const inv = c.payment_intent ? piInvoice.get(c.payment_intent) : undefined;
      return {
        id: c.id, customer: c.customer, status: c.status, amount: c.amount / 100, refunded: (c.amount_refunded ?? 0) / 100,
        created: c.created, subscription: inv ? invoiceSub.get(inv) ?? null : null, failureMessage: c.failure_message,
      };
    }),
    invoices: invoices.map((i) => ({
      id: i.id, customer: i.customer, subscription: invoiceSub.get(i.id) ?? null, status: i.status,
      attemptCount: i.attempt_count ?? 0, nextAttempt: i.next_payment_attempt, amountDue: i.amount_due / 100,
      amountRemaining: i.amount_remaining / 100, created: i.created, number: i.number, url: i.hosted_invoice_url,
    })),
  };
}

export const getStripeSnapshot = ttlCache(loadSnapshot, { ttlMs: 10 * 60_000, staleMs: 50 * 60_000, key: () => "account", shared: "stripe-account" });

/** Explicit links and exclusions (0030); none before the migration. */
export async function listStripeLinks(): Promise<{ links: StripeLinkRow[]; ready: boolean }> {
  const { data, error } = await osTable("os_client_stripe_links").select("os_client_id, stripe_customer_id, stripe_subscription_id, excluded");
  if (error) return { links: [], ready: false };
  return {
    ready: true,
    links: ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      clientId: String(r.os_client_id), customerId: String(r.stripe_customer_id),
      subscriptionId: (r.stripe_subscription_id as string | null) ?? null, excluded: r.excluded === true,
    })),
  };
}

async function clientRefs(): Promise<BillingClientRef[]> {
  let res = await osTable("os_clients").select("id, name, aliases, stripe_customer_id, stripe_subscription_id, signup_date");
  if (res.error) res = await osTable("os_clients").select("id, name, aliases, stripe_customer_id, stripe_subscription_id");
  if (res.error) throw new Error(`os_clients: ${res.error.message}`);
  return ((res.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id), name: String(r.name ?? ""), aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
    stripeCustomerId: (r.stripe_customer_id as string | null) ?? null,
    stripeSubscriptionId: (r.stripe_subscription_id as string | null) ?? null,
    signupDate: (r.signup_date as string | null) ?? null,
  }));
}

export interface AccountBilling {
  byClient: Map<string, ClientBilling>;
  totals: ReturnType<typeof billingTotals>;
  upcoming: ReturnType<typeof upcomingCharges>;
  linksReady: boolean;
  snapshot: AccountSnapshot;
}

/** Every client's billing, the business totals and the 30-day calendar. */
export async function getAccountBilling(): Promise<AccountBilling> {
  const [snapshot, refs, { links, ready }] = await Promise.all([getStripeSnapshot(), clientRefs(), listStripeLinks()]);
  const byClient = buildBilling(refs, snapshot, links);
  return { byClient, totals: billingTotals(snapshot, byClient), upcoming: upcomingCharges(snapshot, byClient, 30), linksReady: ready, snapshot };
}

/**
 * The client's OTHER subscriptions still collecting — not the record's (6 Oct).
 * A pause or churn must stop these too, or a second subscription (54 Realty)
 * keeps charging. Resuming touches only the record's, so a subscription
 * paused by hand is never restarted behind anyone's back.
 */
export async function otherCollectingSubscriptions(clientId: string, recordSub: string | null): Promise<string[]> {
  const b = (await getAccountBilling()).byClient.get(clientId);
  return (b?.subscriptions ?? [])
    .filter((s) => s.id !== recordSub && !s.collectionPaused && !["canceled", "incomplete_expired"].includes(s.status))
    .map((s) => s.id);
}
