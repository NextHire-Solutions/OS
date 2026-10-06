import "server-only";

import { getMasterClientList, type MasterClient } from "@/lib/clients/master-list";
import { ttlCache } from "@/lib/cache/ttl";
import { getAccountBilling } from "@/lib/clients/billing-account";
import type { BillingTotals } from "@/lib/clients/billing-model";

import { performanceFrom, type Performance as MovementPerformance } from "./performance-model";

export type { MonthRow, PlanBreakdown } from "./performance-model";

/** Billing across every subscription (6 Oct): the business totals and the next 30 days. */
export interface PerformanceBilling {
  totals: BillingTotals;
  /** The billing calendar: each live subscription's charges in the next 30 days. */
  upcoming: Array<{ date: string; client: string | null; amount: number; every: string }>;
}

export type Performance = MovementPerformance & { billing: PerformanceBilling | null; billingError: string | null };

/*
 * Revenue and billing come from one read of the whole Stripe account
 * (billing-account.ts) — every subscription and card a client has, not just
 * the one on its record, so a client paying through two (54 Realty) counts in
 * full. Monthly revenue is everything Stripe collected that month, less refunds.
 */
async function load(): Promise<Performance> {
  let clients: MasterClient[];
  try {
    clients = (await getMasterClientList()).clients;
  } catch (error) {
    return { ...performanceFrom([], null, error instanceof Error ? error.message : "The client record is unreachable"), billing: null, billingError: null };
  }
  let revenue: Map<string, number> | null = null;
  let billing: PerformanceBilling | null = null;
  let billingError: string | null = null;
  let onStripe = 0;
  try {
    const a = await getAccountBilling();
    revenue = new Map();
    const month = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(new Date(t * 1000)).slice(0, 7);
    for (const ch of a.snapshot.charges) {
      if (ch.status !== "succeeded") continue;
      const m = month(ch.created);
      revenue.set(m, (revenue.get(m) ?? 0) + ch.amount - ch.refunded);
    }
    const name = new Map(clients.map((c) => [c.id, c.name]));
    onStripe = [...a.byClient.values()].filter((b) => b.subscriptions.length > 0).length;
    billing = { totals: a.totals, upcoming: a.upcoming.map((u) => ({ date: u.date, client: u.clientId ? name.get(u.clientId) ?? null : null, amount: u.amount, every: u.every })) };
  } catch (error) {
    billingError = error instanceof Error ? error.message : "Stripe could not be read";
  }
  return { ...performanceFrom(clients, revenue, null, onStripe), billing, billingError };
}

export const getPerformance = ttlCache(load, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000, shared: "performance" });
