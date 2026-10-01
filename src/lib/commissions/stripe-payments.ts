import "server-only";

import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";
import { stripeKey } from "@/lib/tools/onboarding/stripe";

import { easternDay, round2, type Payment } from "./schedule";

/*
 * The money that actually came in on a client's subscription: every PAID
 * Stripe invoice — the Eastern day it was paid and the amount paid (before
 * Stripe's fees). Read-only: this only lists invoices.
 *
 * Paused collection and cancellation need no special handling here: no
 * invoice is paid, so no payment appears.
 */
/*
 * Every Stripe read goes through here: at most 4 at once, and a 429 (Stripe's
 * rate limit) or a 5xx is retried after the delay Stripe asks for. Commissions
 * reads ~30 subscriptions for an admin; fired all at once, some came back
 * rate-limited and those clients showed "No billing data" (audit, 30 Sep).
 */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot(): Promise<() => void> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  return () => { inFlight--; waiting.shift()?.(); };
}

export async function stripeGet(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const release = await slot();
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${stripeKey()}` }, cache: "no-store" });
    } finally {
      release();
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 4000)));
      continue;
    }
    return res;
  }
}

async function load(subscriptionId: string): Promise<Payment[]> {
  const out: Payment[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ subscription: subscriptionId, status: "paid", limit: "100" });
    if (after) q.set("starting_after", after);
    const res = await stripeGet(`https://api.stripe.com/v1/invoices?${q}`);
    const body = (await res.json().catch(() => null)) as {
      data?: { id: string; amount_paid?: number; status_transitions?: { paid_at?: number | null }; created?: number }[];
      has_more?: boolean; error?: { message?: string };
    } | null;
    if (!res.ok || !body?.data) throw new Error(`Stripe invoices: ${body?.error?.message ?? res.status}`);
    for (const inv of body.data) {
      const paidAt = inv.status_transitions?.paid_at ?? inv.created;
      if (!paidAt || !inv.amount_paid) continue; // a $0 invoice is not a payment
      out.push({ date: easternDay(paidAt * 1000), amount: round2(inv.amount_paid / 100), source: "stripe" });
    }
    if (!body.has_more || !body.data.length) break;
    after = body.data[body.data.length - 1].id;
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Cached ten minutes per subscription — payments change on a 14-day cadence. */
export const stripePayments = ttlCache(load, { ttlMs: 10 * 60_000, staleMs: 50 * 60_000, key: (id: string) => id });

/**
 * What the subscription bills per 28 days (BrokerStaffer's month), from its
 * current price: $1,500 every 14 days → $3,000; $1,000 every 28 days →
 * $1,000; a monthly price is taken as it is. Null when it cannot be read.
 */
async function loadGross(subscriptionId: string): Promise<{ per28: number; cycleDays: number | null; paused: boolean } | null> {
  const res = await stripeGet(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=items.data.price`);
  const s = (await res.json().catch(() => null)) as {
    items?: { data?: { quantity?: number; price?: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } } }[] };
    pause_collection?: unknown;
  } | null;
  if (!res.ok || !s?.items?.data?.length) return null;
  let per28 = 0;
  let cycleDays: number | null = null;
  for (const it of s.items.data) {
    const amount = ((it.price?.unit_amount ?? 0) / 100) * (it.quantity ?? 1);
    const r = it.price?.recurring;
    const n = r?.interval_count ?? 1;
    const days = r?.interval === "day" ? n : r?.interval === "week" ? n * 7 : null;
    if (days) { per28 += (amount * 28) / days; cycleDays = days; }
    else if (r?.interval === "month") per28 += amount / n;
    else if (r?.interval === "year") per28 += amount / (12 * n);
  }
  return { per28: round2(per28), cycleDays, paused: Boolean(s.pause_collection) };
}

export const stripeGross = ttlCache(loadGross, { ttlMs: 10 * 60_000, staleMs: 50 * 60_000, key: (id: string) => id });
