/*
 * Linking a client to its Stripe customer and subscription — the rule.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS HAS TO BE CHECKED, NOT JUST STORED
 *
 * The billing leg of status propagation (stripe-billing-live.ts) acts on
 * whatever subscription is recorded here: pausing a client pauses THAT
 * subscription, in live mode, on real money. So a mistyped id is not a data
 * quality problem. `sub_1Abc` one character off is a different customer's
 * subscription, and churning this client would stop billing someone else.
 *
 * So a subscription is only accepted once Stripe confirms it exists and
 * belongs to the customer it is being recorded against.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 *
 * Until 28 Sep 2026 nothing in the OS could set these two fields. The 30 that
 * existed were mapped by script from the client's own sheet (migration 0016),
 * onboarding never linked one, and the Edit dialog had no field — so for every
 * client added afterwards, and the 20 without one, a pause or churn silently
 * did nothing to billing. This is the missing way in.
 *
 * Pure, so the decision is testable without a Stripe account. The one network
 * call lives in `verifyStripeLink` in edit.ts's caller.
 */

export const CUSTOMER_ID = /^cus_[A-Za-z0-9]{6,}$/;
export const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{6,}$/;

/** The format checks, run before anything is read or written. */
export function stripeIdErrors(customer: string | null | undefined, subscription: string | null | undefined): string[] {
  const errors: string[] = [];
  const c = (customer ?? "").trim();
  const s = (subscription ?? "").trim();
  if (c && !CUSTOMER_ID.test(c)) {
    errors.push(`Stripe customer ID must look like cus_… — "${c}" does not.`);
  }
  if (s && !SUBSCRIPTION_ID.test(s)) {
    errors.push(`Stripe subscription ID must look like sub_… — "${s}" does not.`);
  }
  return errors;
}

/** What Stripe said about the subscription. */
export type StripeLookup =
  | { found: true; customer: string }
  | { found: false }
  /** Stripe could not be asked — no key, network, or 5xx. Not the same as "no such subscription". */
  | { unreachable: true; reason: string };

export type LinkDecision =
  | { ok: true; customer: string | null; subscription: string | null; filledCustomer: boolean }
  | { ok: false; error: string };

/**
 * Whether this (customer, subscription) pair may be saved, given what Stripe
 * says about the subscription.
 *
 * `lookup` is null when there is no subscription to check.
 */
export function decideStripeLink(
  customer: string | null,
  subscription: string | null,
  lookup: StripeLookup | null,
): LinkDecision {
  const c = customer?.trim() || null;
  const s = subscription?.trim() || null;

  // Clearing the subscription, or recording a customer alone, needs no check:
  // the billing leg keys on the subscription, so neither can move money.
  if (!s) return { ok: true, customer: c, subscription: null, filledCustomer: false };

  if (!lookup) return { ok: false, error: "The subscription could not be checked with Stripe." };

  /*
   * FAIL CLOSED when Stripe cannot be asked.
   *
   * The opposite of the churn guard, which fails open — deliberately. That one
   * is a tidy-up rule where refusing costs an operator their import. This one
   * guards money: saving an unchecked id is exactly the mistake the check
   * exists to prevent, and the cost of refusing is only "try again".
   */
  if ("unreachable" in lookup) {
    return { ok: false, error: `Stripe could not be reached to confirm ${s} (${lookup.reason}). Nothing was saved — try again.` };
  }
  if (!lookup.found) {
    return { ok: false, error: `Stripe has no subscription ${s}. Check the ID in the Stripe dashboard.` };
  }

  // Customer left blank: take it from Stripe rather than making someone type
  // a second id that could be wrong.
  if (!c) return { ok: true, customer: lookup.customer, subscription: s, filledCustomer: true };

  if (lookup.customer !== c) {
    return {
      ok: false,
      error: `Subscription ${s} belongs to ${lookup.customer} in Stripe, not ${c}. ` +
        "Linking it would let this client's status change someone else's billing.",
    };
  }
  return { ok: true, customer: c, subscription: s, filledCustomer: false };
}
