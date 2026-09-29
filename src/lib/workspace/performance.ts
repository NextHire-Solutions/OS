import "server-only";

import { getMasterClientList, type MasterClient } from "@/lib/clients/master-list";
import { ttlCache } from "@/lib/cache/ttl";
import { stripePayments } from "@/lib/commissions/stripe-payments";

import { performanceFrom, type Performance } from "./performance-model";

export type { Performance, MonthRow, PlanBreakdown } from "./performance-model";

/*
 * The Performance screen: client base, plan mix and movement — from the
 * master client record (30 Sep), no longer from Client Health's flags.
 *
 *   Added     each client's onboarding date (0023), or its start date when
 *             no onboarding date is recorded
 *   Churned   each churned client's churn date (0023, stamped when the status
 *             changes to Churned, and editable on the record)
 *   Revenue   what Stripe actually collected: paid invoices on each linked
 *             client's subscription, by the month they were paid
 *
 * Where a date is missing the client is COUNTED as undated, never guessed —
 * the screen says how many and where to add them.
 */

async function load(): Promise<Performance> {
  let clients: MasterClient[];
  try {
    clients = (await getMasterClientList()).clients;
  } catch (error) {
    return performanceFrom([], null, error instanceof Error ? error.message : "The client record is unreachable");
  }
  // Revenue: every linked subscription's paid invoices (throttled, cached).
  const linked = clients.filter((c) => c.stripeSubscriptionId);
  let revenue: Map<string, number> | null = new Map();
  const results = await Promise.all(linked.map((c) => stripePayments(c.stripeSubscriptionId!).catch(() => null)));
  if (results.some((r) => r === null)) revenue = null; // a partial total would under-report as if it were whole
  else for (const list of results) for (const p of list!) {
    const m = p.date.slice(0, 7);
    revenue.set(m, (revenue.get(m) ?? 0) + p.amount);
  }
  return performanceFrom(clients, revenue, null, linked.length);
}

export const getPerformance = ttlCache(load, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000, shared: "performance" });
