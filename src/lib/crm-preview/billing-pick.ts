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

/**
 * The clients that MAY open Stripe's billing page on a customer they share with another client — by name, and only
 * on the user's word. Stripe's page then shows everything on that customer, the other client's plan, invoices and the
 * card included, and lets them be changed.
 *
 *   Douglas Elliman Las Vegas (19 Nov; it asked for "Manage billing"; the user: "Turn it on anyway, if one person
 *   manages billing for both offices"). Its customer "Douglas Elliman Real Estate" also pays for Douglas Elliman Los
 *   Angeles, which is NOT on this list (its button stays off). Its Billing page still lists only its own invoices.
 */
export const SHARED_BILLING_OPEN: ReadonlySet<string> = new Set([
  "7fb537e9-19ef-4ed5-853c-7333356cf424", // Douglas Elliman Las Vegas (its os_clients id — billing is keyed by it, not the portal id)
]);

export function pickBillingCustomer(
  account: Pick<ClientBilling, "clientId" | "subscriptions" | "customers"> | null | undefined,
  /** Every client's billing (getAccountBilling().byClient): a customer any OTHER client has a subscription on, or claims, is never opened. */
  everyone: Iterable<Pick<ClientBilling, "clientId" | "subscriptions" | "customers">> = [],
  /** Clients allowed to open a shared customer anyway (SHARED_BILLING_OPEN); empty = the plain rule. */
  openShared: ReadonlySet<string> = SHARED_BILLING_OPEN,
): BillingPick {
  if (!account || (!account.customers.length && !account.subscriptions.length)) return { ok: false, reason: "no-billing" };
  const current = account.subscriptions.find((s) => s.current);
  const customer = current?.customer ?? (account.customers.length === 1 ? account.customers[0].id : null);
  if (!customer) return { ok: false, reason: account.customers.length ? "ambiguous" : "no-billing" };
  const claim = account.customers.find((c) => c.id === customer);
  if (!claim) return { ok: false, reason: "ambiguous" };
  const allowed = openShared.has(account.clientId);
  if (claim.shared) return allowed ? { ok: true, customer } : { ok: false, reason: "shared" };
  /*
   * "shared" is only "claimed by two clients". A subscription linked to
   * another client by hand, on a customer that client was excluded from,
   * would not count (21 Oct review) — and Stripe's page would show that
   * client's subscription and let it be cancelled. Any other client with a
   * subscription on, or a claim to, this customer: refused.
   */
  for (const other of everyone) {
    if (other.clientId === account.clientId) continue;
    if (other.subscriptions.some((s) => s.customer === customer) || other.customers.some((c) => c.id === customer)) return allowed ? { ok: true, customer } : { ok: false, reason: "shared" };
  }
  return { ok: true, customer };
}

/**
 * Which invoices the portal's Billing PAGE may list (17 Nov — Douglas Elliman Las Vegas, whose card also pays for
 * Douglas Elliman Los Angeles). Not the same question as the Billing link: Stripe's billing page shows a whole
 * customer, so a shared customer is never opened (above); a list of invoices can be cut to the client's own.
 *
 *   - the customer is the client's alone: every invoice on it, and "Manage billing" opens it (manage: true);
 *   - the customer is shared: only invoices of the client's OWN subscriptions — owned by a person's link, the
 *     client's record, or the OS having made it for them, never by guess — and no other client's (manage: false:
 *     card and plan changes go through our team; manage: true for a client on SHARED_BILLING_OPEN, whose list is
 *     still its own). Invoices with no subscription on a shared customer (a one-off) are no one's to show;
 *   - otherwise the Billing link's refusal.
 */
export type InvoiceScope =
  | { ok: true; manage: true; customer: string }
  /** A shared customer: the client's own subscriptions; `manage` only for a client on SHARED_BILLING_OPEN. */
  | { ok: true; manage: boolean; subscriptions: string[] }
  | { ok: false; reason: "no-billing" | "shared" | "ambiguous" };

const OWNED = new Set(["linked", "record", "created by the OS"]);

export function invoiceScope(
  account: Pick<ClientBilling, "clientId" | "subscriptions" | "customers"> | null | undefined,
  everyone: Iterable<Pick<ClientBilling, "clientId" | "subscriptions" | "customers">> = [],
  openShared: ReadonlySet<string> = SHARED_BILLING_OPEN,
): InvoiceScope {
  const others = [...everyone].filter((o) => o.clientId !== account?.clientId);
  // Whether the customer is shared at all — asked WITHOUT the allow list, so the invoice list stays the client's own.
  const pick = pickBillingCustomer(account, others, new Set());
  if (pick.ok) return { ok: true, manage: true, customer: pick.customer };
  if (pick.reason !== "shared" || !account) return pick;
  const theirs = new Set(others.flatMap((o) => o.subscriptions.map((s) => s.id)));
  const mine = account.subscriptions.filter((s) => OWNED.has(s.source) && !theirs.has(s.id)).map((s) => s.id);
  return mine.length ? { ok: true, manage: openShared.has(account.clientId), subscriptions: mine } : { ok: false, reason: "shared" };
}

/** What the person sees when the page cannot be opened. */
export const BILLING_REFUSAL: Record<Exclude<BillingPick, { ok: true }>["reason"], string> = {
  "no-billing": "There is no billing set up for this account yet. Please contact us and we'll help.",
  shared: "Billing for this account is handled by our team, because it shares a payment method with another account. Please contact us for invoices or changes.",
  ambiguous: "We couldn't tell which billing account to open. Please contact us and we'll help.",
};
