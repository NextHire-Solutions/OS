import "server-only";

import { getMasterClientList, type MasterClient } from "@/lib/clients/master-list";
import { ttlCache } from "@/lib/cache/ttl";
import { getAccountBilling } from "@/lib/clients/billing-account";
import type { BillingTotals, SubscriptionRow, UnattributedCustomer } from "@/lib/clients/billing-model";

import { performanceFrom, type Performance as MovementPerformance } from "./performance-model";
import type { RangeClient } from "./performance-range";

export type { MonthRow, PlanBreakdown } from "./performance-model";

/** Billing across every subscription (6 Oct): the business totals and the next 30 days. */
export interface PerformanceBilling {
  totals: BillingTotals;
  /** The billing calendar: each live subscription's charges in the next 30 days. */
  upcoming: Array<{ date: string; client: string | null; amount: number; every: string }>;
}

/** A subscription in the list behind the Active / Paused tiles, with the client's own details beside Stripe's. */
export type SubscriptionListRow = SubscriptionRow & {
  /** The client's name, or the Stripe customer's when no client is tied to it. */
  client: string;
  /** The client's areas, as entered on its record ("Boston, Cape Cod"); null when none. */
  market: string | null;
  plan: string | null;
};

/*
 * Everything the page needs to compute its RANGE tiles for ANY range, in the
 * browser (performance-range.ts) — so changing the date filter is instant and
 * asks the server nothing. Small: one line per client and one per day money
 * was collected.
 */
export interface PerformanceFacts {
  /** The business's day (Eastern). */
  today: string;
  /** The first day anything happened — where "All time" starts. */
  earliest: string;
  clients: RangeClient[];
  /** [day, collected less refunds]; null when Stripe could not be read. */
  revenueByDay: Array<[string, number]> | null;
  /** Null when Stripe could not be read. */
  subscriptions: SubscriptionListRow[] | null;
  unattributed: UnattributedCustomer[] | null;
  /** How each "signed" date was found — said on the page, because the three are not equally exact. */
  signedBy: { stripe: number; entered: number; onboarding: number; none: number };
}

export type Performance = MovementPerformance & { billing: PerformanceBilling | null; billingError: string | null; facts: PerformanceFacts };

/*
 * Revenue and billing come from one read of the whole Stripe account
 * (billing-account.ts) — every subscription and card a client has, not just
 * the one on its record, so a client paying through two (54 Realty) counts in
 * full. Monthly revenue is everything Stripe collected that month, less refunds.
 */
async function load(): Promise<Performance> {
  let clients: MasterClient[];
  // Without the status history, pauses are unknown — shown as such, not as 0.
  let pauseHistory = true;
  try {
    const list = await getMasterClientList();
    clients = list.clients;
    pauseHistory = !list.unavailable.includes("Status history");
  } catch (error) {
    return {
      ...performanceFrom([], null, error instanceof Error ? error.message : "The client record is unreachable"), billing: null, billingError: null,
      facts: { today: easternToday(), earliest: easternToday(), clients: [], revenueByDay: null, subscriptions: null, unattributed: null, signedBy: { stripe: 0, entered: 0, onboarding: 0, none: 0 } },
    };
  }
  let revenue: Map<string, number> | null = null;
  let billing: PerformanceBilling | null = null;
  let billingError: string | null = null;
  let onStripe = 0;
  const today = easternToday();
  const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
  const facts: PerformanceFacts = {
    today, earliest: today, clients: [], revenueByDay: null, subscriptions: null, unattributed: null,
    signedBy: { stripe: 0, entered: 0, onboarding: 0, none: 0 },
  };
  let stripeSigned = new Map<string, { date: string | null; source: string | null }>();
  let monthsPaid = new Map<string, number>();
  try {
    const a = await getAccountBilling();
    stripeSigned = new Map([...a.byClient.entries()].map(([id, b]) => [id, { date: b.signupDate, source: b.signupSource }]));
    monthsPaid = a.monthsPaid;
    facts.revenueByDay = [...a.revenueByDay.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    facts.unattributed = a.unattributed;
    const byId = new Map(clients.map((c) => [c.id, c]));
    facts.subscriptions = a.subscriptions.map((s) => {
      const c = s.clientId ? byId.get(s.clientId) : undefined;
      return {
        ...s,
        client: c?.name ?? s.customerName ?? "Unknown customer",
        market: c?.markets?.areas?.length ? c.markets.areas.join(", ") : null,
        plan: c?.plan ?? null,
      };
    });
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
  /*
   * SIGNED: the first $1 charge in Stripe (the card check at sign-up) when
   * there is one; else the sign-up date entered on the record; else the
   * onboarding date, so a client nobody dated by hand is not silently missing
   * from "signed in range". Which of the three each client used is counted and
   * said on the page.
   */
  facts.clients = clients.map((c) => {
    const s = stripeSigned.get(c.id);
    const fromStripe = s?.source === "first $1 charge" || s?.source === "first charge" ? day(s.date) : null;
    const entered = day(c.signupDate);
    const onboarding = day(c.onboardingDate);
    const signed = fromStripe ?? entered ?? onboarding;
    facts.signedBy[fromStripe ? "stripe" : entered ? "entered" : onboarding ? "onboarding" : "none"] += 1;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      signed,
      added: day(c.onboardingDate ?? c.signupDate),
      churned: c.status === "churned" ? day(c.churnDate) : null,
      monthsPaid: monthsPaid.get(c.id) ?? null,
    };
  });
  const firsts = [
    ...facts.clients.flatMap((c) => [c.signed, c.added]).filter((d): d is string => !!d),
    ...(facts.revenueByDay?.length ? [facts.revenueByDay[0][0]] : []),
  ].sort();
  facts.earliest = firsts[0] ?? today;
  return { ...performanceFrom(clients, revenue, null, onStripe, new Date(), pauseHistory), billing, billingError, facts };
}

/** The business's calendar day. */
function easternToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// `-v2`: the shape gained `facts` on 13 Oct; a shared cache outlives a hot reload.
export const getPerformance = ttlCache(load, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000, shared: "performance-v2" });
