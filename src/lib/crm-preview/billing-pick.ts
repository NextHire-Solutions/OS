/*
 * Which Stripe customer a portal's Billing link may open (19 Oct) — pure, tested.
 *
 * Stripe's billing page shows EVERYTHING on a customer: every subscription,
 * every invoice, and lets the card be changed and a subscription cancelled.
 * So it may open only a customer that is this client's alone:
 *
 *   - the customer of the client's current subscription (billing-model.ts
 *     decides "current" and who owns what, as everywhere else); with no
 *     subscription, the client's one customer, if it has exactly one;
 *   - never a customer another client also pays through (Raintown Realty
 *     and JPAR share one card) — that page would show the other client's
 *     subscription and let it be cancelled. Refused, with a word to contact us.
 */

import type { ClientBilling } from "@/lib/clients/billing-model";

export type BillingPick =
  | { ok: true; customer: string }
  | { ok: false; reason: "no-billing" | "shared" | "ambiguous" };

export function pickBillingCustomer(
  account: Pick<ClientBilling, "clientId" | "subscriptions" | "customers"> | null | undefined,
  /** Every client's billing (getAccountBilling().byClient): a customer any OTHER client has a subscription on, or claims, is never opened. */
  everyone: Iterable<Pick<ClientBilling, "clientId" | "subscriptions" | "customers">> = [],
): BillingPick {
  if (!account || (!account.customers.length && !account.subscriptions.length)) return { ok: false, reason: "no-billing" };
  const current = account.subscriptions.find((s) => s.current);
  const customer = current?.customer ?? (account.customers.length === 1 ? account.customers[0].id : null);
  if (!customer) return { ok: false, reason: account.customers.length ? "ambiguous" : "no-billing" };
  const claim = account.customers.find((c) => c.id === customer);
  if (!claim) return { ok: false, reason: "ambiguous" };
  if (claim.shared) return { ok: false, reason: "shared" };
  /*
   * "shared" is only "claimed by two clients". A subscription linked to
   * another client by hand, on a customer that client was excluded from,
   * would not count (21 Oct review) — and Stripe's page would show that
   * client's subscription and let it be cancelled. Any other client with a
   * subscription on, or a claim to, this customer: refused.
   */
  for (const other of everyone) {
    if (other.clientId === account.clientId) continue;
    if (other.subscriptions.some((s) => s.customer === customer) || other.customers.some((c) => c.id === customer)) return { ok: false, reason: "shared" };
  }
  return { ok: true, customer };
}

/** What the person sees when the page cannot be opened. */
export const BILLING_REFUSAL: Record<Exclude<BillingPick, { ok: true }>["reason"], string> = {
  "no-billing": "There is no billing set up for this account yet. Please contact us and we'll help.",
  shared: "Billing for this account is handled by our team, because it shares a payment method with another account. Please contact us for invoices or changes.",
  ambiguous: "We couldn't tell which billing account to open. Please contact us and we'll help.",
};
