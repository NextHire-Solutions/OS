import "server-only";

import { easternDay } from "@/lib/commissions/schedule";
import { stripeGet } from "@/lib/commissions/stripe-payments";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import { cents, monthlyAmount } from "./profile-rules";

/*
 * A client's Stripe figures, as the Stripe customer page shows them (Eddy,
 * 1 Oct): Total spend, MRR, and the day the customer was created (the
 * default Sign up date). Read-only — this only lists.
 *
 *   Total spend  every successful charge on the customer, less refunds —
 *                The Rafeh Group: 8 charges, $4,501.00, as Stripe shows.
 *   MRR          the customer's live subscriptions (active or past due, not
 *                paused) as a monthly amount, Stripe's way: $750 every 14
 *                days → $1,630.58. Percent-off coupons are applied.
 */

export interface StripeSummary {
  signupDate: string | null;
  totalSpend: number;
  transactions: number;
  mrr: number;
}

type Charge = { id: string; status: string; amount: number; amount_refunded: number };
type Sub = {
  status: string;
  pause_collection?: unknown;
  discount?: { coupon?: { percent_off?: number | null } } | null;
  items?: { data?: { quantity?: number; price?: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } } }[] };
};

async function json<T>(url: string): Promise<T> {
  const res = await stripeGet(url);
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !body) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
  return body;
}

async function load(key: string): Promise<StripeSummary> {
  const [customerIdIn, subscriptionId] = key.split("|");
  let customerId = customerIdIn;
  if (!customerId && subscriptionId) {
    customerId = (await json<{ customer: string }>(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`)).customer;
  }
  const customer = await json<{ created?: number }>(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`);

  let totalCents = 0, transactions = 0, after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ customer: customerId, limit: "100" });
    if (after) q.set("starting_after", after);
    const body = await json<{ data: Charge[]; has_more: boolean }>(`https://api.stripe.com/v1/charges?${q}`);
    for (const ch of body.data) {
      if (ch.status !== "succeeded") continue;
      transactions++;
      totalCents += ch.amount - (ch.amount_refunded ?? 0);
    }
    if (!body.has_more || !body.data.length) break;
    after = body.data[body.data.length - 1].id;
  }

  const subs = await json<{ data: Sub[] }>(`https://api.stripe.com/v1/subscriptions?${new URLSearchParams({ customer: customerId, status: "all", limit: "100" })}`);
  let mrr = 0;
  for (const s of subs.data) {
    if (!["active", "past_due"].includes(s.status) || s.pause_collection) continue;
    const off = s.discount?.coupon?.percent_off ?? 0;
    for (const it of s.items?.data ?? []) {
      const amount = ((it.price?.unit_amount ?? 0) / 100) * (it.quantity ?? 1);
      mrr += monthlyAmount(amount, it.price?.recurring?.interval, it.price?.recurring?.interval_count ?? 1) * (1 - off / 100);
    }
  }

  return {
    signupDate: customer.created ? easternDay(customer.created * 1000) : null,
    totalSpend: cents(totalCents / 100),
    transactions,
    mrr: cents(mrr),
  };
}

/** Cached ten minutes per customer — these move on a 14-day cadence. */
const summary = ttlCache(load, { ttlMs: 10 * 60_000, staleMs: 50 * 60_000, key: (k: string) => k, shared: "stripe-client-summary" });

/** Every client's figures that Stripe could give; the ones it could not are named. */
export async function stripeSummaries(clients: { id: string; name: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null }[]) {
  const linked = clients.filter((c) => c.stripeCustomerId || c.stripeSubscriptionId);
  const out: Record<string, StripeSummary> = {};
  const failed: string[] = [];
  await Promise.all(linked.map(async (c) => {
    try {
      out[c.id] = await summary(`${c.stripeCustomerId ?? ""}|${c.stripeSubscriptionId ?? ""}`);
    } catch {
      failed.push(c.name);
    }
  }));
  return { byId: out, failed: failed.sort() };
}
