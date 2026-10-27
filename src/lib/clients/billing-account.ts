import "server-only";

import { stripeGet } from "@/lib/commissions/stripe-payments";
import { osTable } from "@/lib/clients/os-db";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import {
  billingTotals,
  buildBilling,
  clientBillingDetail,
  monthsPaidByClient,
  revenueByDay,
  subscriptionRows,
  unattributedByCustomer,
  upcomingCharges,
  type AccountSnapshot,
  type BillingClientRef,
  type ClientBilling,
  type ClientBillingDetail,
  type StripeLinkRow,
  type SubscriptionRow,
  type UnattributedCustomer,
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
  cancel_at?: number | null; cancel_at_period_end?: boolean; ended_at?: number | null;
  current_period_end?: number;
  pause_collection: { behavior: string; resumes_at: number | null } | null;
  discount?: { coupon?: { percent_off?: number | null } } | null;
  discounts?: Array<{ coupon?: { percent_off?: number | null } } | string>;
  metadata?: Record<string, string>;
  items: { data: Array<{ quantity?: number; current_period_end?: number; price?: { unit_amount?: number | null; product?: string | { id: string } | null; recurring?: { interval?: string; interval_count?: number } } }> };
};
type RawInvoice = {
  id: string; customer: string; status: string; attempt_count: number; next_payment_attempt: number | null;
  amount_due: number; amount_remaining: number; created: number; number: string | null; hosted_invoice_url: string | null;
  subscription?: string | null; parent?: { subscription_details?: { subscription?: string | null } | null } | null;
  total?: number; amount_paid?: number; invoice_pdf?: string | null; period_start?: number; period_end?: number;
  post_payment_credit_notes_amount?: number;
  status_transitions?: { paid_at?: number | null } | null; lines?: { data?: Array<{ description?: string | null; period?: { start?: number; end?: number } | null }> } | null;
};
/*
 * What an invoice pays for: its line's service period (22 Oct). The invoice's
 * own period_start/period_end is not it — a subscription billed in advance
 * carries the PREVIOUS period there, or an empty one on its first invoice.
 * The longest line wins (a proration line is shorter than the plan's).
 */
function servicePeriod(i: RawInvoice): { serviceStart?: number; serviceEnd?: number } {
  let best: { start: number; end: number } | null = null;
  for (const l of i.lines?.data ?? []) {
    const s = l.period?.start;
    const e = l.period?.end;
    if (typeof s !== "number" || typeof e !== "number" || e <= s) continue;
    if (!best || e - s > best.end - best.start) best = { start: s, end: e };
  }
  return best ? { serviceStart: best.start, serviceEnd: best.end } : {};
}

type RawCharge = {
  id: string; customer: string | null; status: string; amount: number; amount_refunded: number; created: number; payment_intent: string | null; failure_message: string | null;
  description?: string | null; receipt_url?: string | null; payment_method_details?: { type?: string; card?: { brand?: string | null; last4?: string | null } | null } | null;
};
type RawInvoicePayment = { id: string; invoice: string; payment?: { payment_intent?: string | null } };
/* A credit note: who issued a refund from the OS is in its metadata (billing-refund.ts). */
type RawCreditNote = { id: string; number: string | null; invoice: string | null; created: number; amount: number; pdf?: string | null; reason?: string | null; refunds?: Array<{ refund?: string | { id: string } | null }> | null; refund?: string | null; metadata?: Record<string, string> | null };
type RawRefund = { id: string; charge: string | null; amount: number; created: number; status: string; reason: string | null };

/** "Visa •••• 4242", or the payment method's type when it is not a card. */
function cardOf(c: RawCharge): string | null {
  const card = c.payment_method_details?.card;
  if (card?.last4) {
    const brand = (card.brand ?? "card").replace(/^amex$/, "American Express").replace(/^\w/, (x) => x.toUpperCase());
    return `${brand} •••• ${card.last4}`;
  }
  const type = c.payment_method_details?.type;
  return type ? type.replace(/_/g, " ") : null;
}

async function loadSnapshot(): Promise<AccountSnapshot> {
  const [customers, subs, charges, invoices, payments, refunds, products, creditNotes] = await Promise.all([
    all<{ id: string; name: string | null; email: string | null; created: number }>("customers"),
    all<RawSub>("subscriptions?status=all"),
    all<RawCharge>("charges"),
    all<RawInvoice>("invoices"),
    all<RawInvoicePayment>("invoice_payments"),
    // For the Billing tab (19 Oct). A failure here never takes billing down: the tab shows payments without refund rows or plan names.
    all<RawRefund>("refunds").catch(() => null),
    all<{ id: string; name: string }>("products").catch(() => null),
    // For refunds from the Billing tab (22 Oct): who issued each one. Optional, like refunds.
    all<RawCreditNote>("credit_notes").catch(() => null),
  ]);
  const invoiceSub = new Map(invoices.map((i) => [i.id, i.parent?.subscription_details?.subscription ?? i.subscription ?? null]));
  const piInvoice = new Map(payments.filter((p) => p.payment?.payment_intent).map((p) => [p.payment!.payment_intent!, p.invoice]));
  return {
    customers: customers.map((c) => ({ id: c.id, name: c.name, email: c.email, created: c.created })),
    subscriptions: subs.map((s) => {
      const off = s.discount?.coupon?.percent_off
        ?? s.discounts?.map((d) => (typeof d === "string" ? null : d.coupon?.percent_off)).find((v) => typeof v === "number") ?? 0;
      return {
        id: s.id, customer: s.customer, status: s.status, created: s.created, canceledAt: s.canceled_at, endedAt: s.ended_at ?? null,
        pause: s.pause_collection ? { behavior: s.pause_collection.behavior, resumesAt: s.pause_collection.resumes_at } : null,
        periodEnd: s.items.data[0]?.current_period_end ?? s.current_period_end ?? null,
        // A cancellation already set (the Billing tab's Cancel, or Stripe's dashboard): when it stops.
        cancelAt: s.cancel_at ?? (s.cancel_at_period_end ? s.items.data[0]?.current_period_end ?? s.current_period_end ?? null : null),
        items: s.items.data.map((it) => ({
          amount: (it.price?.unit_amount ?? 0) / 100,
          interval: it.price?.recurring?.interval ?? "month",
          intervalCount: it.price?.recurring?.interval_count ?? 1,
          quantity: it.quantity ?? 1,
          product: typeof it.price?.product === "string" ? it.price.product : it.price?.product?.id ?? null,
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
        description: c.description ?? null, invoice: inv ?? null, card: cardOf(c), hasReceipt: !!c.receipt_url,
      };
    }),
    invoices: invoices.map((i) => ({
      id: i.id, customer: i.customer, subscription: invoiceSub.get(i.id) ?? null, status: i.status,
      attemptCount: i.attempt_count ?? 0, nextAttempt: i.next_payment_attempt, amountDue: i.amount_due / 100,
      amountRemaining: i.amount_remaining / 100, created: i.created, number: i.number, url: i.hosted_invoice_url,
      total: typeof i.total === "number" ? i.total / 100 : undefined,
      amountPaid: typeof i.amount_paid === "number" ? i.amount_paid / 100 : undefined,
      pdf: i.invoice_pdf ?? null, paidAt: i.status_transitions?.paid_at ?? null,
      periodStart: i.period_start ?? null, periodEnd: i.period_end ?? null,
      description: i.lines?.data?.[0]?.description ?? null,
      ...servicePeriod(i),
      ...(typeof i.post_payment_credit_notes_amount === "number" ? { creditedAfterPayment: i.post_payment_credit_notes_amount / 100 } : {}),
    })),
    ...(refunds ? { refunds: refunds.map((r) => ({ id: r.id, charge: r.charge, amount: r.amount / 100, created: r.created, status: r.status, reason: r.reason })) } : {}),
    ...(products ? { products: products.map((p) => ({ id: p.id, name: p.name })) } : {}),
    ...(creditNotes
      ? {
          creditNotes: creditNotes.map((c) => ({
            id: c.id, number: c.number, invoice: c.invoice, created: c.created, amount: c.amount / 100, pdf: c.pdf ?? null,
            refunds: [...(c.refunds ?? []).map((r) => (typeof r.refund === "string" ? r.refund : r.refund?.id ?? null)), c.refund ?? null].filter((x): x is string => !!x),
            by: c.metadata?.os_refund_by ?? null, reason: c.reason ?? null,
          })),
        }
      : {}),
    readAt: Date.now(),
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
  /** The Performance page (13 Oct) — all by the same ownership rules as `byClient`. */
  subscriptions: SubscriptionRow[];
  unattributed: UnattributedCustomer[];
  monthsPaid: Map<string, number>;
  revenueByDay: Map<string, number>;
}

/** Every client's billing, the business totals and the 30-day calendar. */
export async function getAccountBilling(): Promise<AccountBilling> {
  const [snapshot, refs, { links, ready }] = await Promise.all([getStripeSnapshot(), clientRefs(), listStripeLinks()]);
  const byClient = buildBilling(refs, snapshot, links);
  return {
    byClient, totals: billingTotals(snapshot, byClient), upcoming: upcomingCharges(snapshot, byClient, 30), linksReady: ready, snapshot,
    subscriptions: subscriptionRows(refs, snapshot, links),
    unattributed: unattributedByCustomer(refs, snapshot, links),
    monthsPaid: monthsPaidByClient(refs, snapshot, links),
    revenueByDay: revenueByDay(snapshot),
  };
}

/**
 * One client's Billing tab (19 Oct). `fresh` re-reads Stripe first — the
 * tab's Refresh — unless the copy is under 30 seconds old (a double click, or
 * two people refreshing together, reads Stripe once).
 */
export async function getClientBillingDetail(clientId: string, fresh = false): Promise<ClientBillingDetail | null> {
  if (fresh) {
    const cached = await getStripeSnapshot();
    if (!cached.readAt || Date.now() - cached.readAt > 30_000) getStripeSnapshot.invalidate();
  }
  const [snapshot, refs, { links }] = await Promise.all([getStripeSnapshot(), clientRefs(), listStripeLinks()]);
  return clientBillingDetail(refs, snapshot, links, clientId);
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
