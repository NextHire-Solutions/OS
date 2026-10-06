import "server-only";

import { getAccountBilling } from "./billing-account";

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
  /** The first $1 charge across every card; else the entered date; else the first charge. */
  signupDate: string | null;
  signupSource: "first $1 charge" | "entered" | "first charge" | null;
  totalSpend: number;
  transactions: number;
  mrr: number;
  /** How many subscriptions the client owns, and the current one. */
  subscriptions: number;
  current: string | null;
  /** Open invoices Stripe failed to collect. */
  failedInvoices: number;
}

/*
 * Since 6 Oct these come from billing-model.ts over the whole account: every
 * subscription and card a client owns, and a shared customer split by
 * subscription (Raintown no longer shows JPAR's $500 as its own). The output
 * keeps its shape, so the Clients list reads it as before.
 */
export async function stripeSummaries(clients: { id: string; name: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null }[]) {
  const out: Record<string, StripeSummary> = {};
  try {
    const { byClient } = await getAccountBilling();
    for (const c of clients) {
      const b = byClient.get(c.id);
      if (!b || (!b.subscriptions.length && !b.customers.length)) continue;
      out[c.id] = {
        signupDate: b.signupDate, signupSource: b.signupSource, totalSpend: b.totalSpend, transactions: b.transactions,
        mrr: b.mrr, subscriptions: b.subscriptions.length, current: b.current, failedInvoices: b.failedInvoices.length,
      };
    }
    return { byId: out, failed: [] as string[] };
  } catch {
    return { byId: out, failed: clients.filter((c) => c.stripeCustomerId || c.stripeSubscriptionId).map((c) => c.name).sort() };
  }
}
