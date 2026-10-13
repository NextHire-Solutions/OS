import "server-only";

import { getAccountBilling } from "./billing-account";
import type { StripeSubscriptionFact } from "./billing-align.ts";

/*
 * Each client's Stripe subscriptions, as the three facts the alignment rule
 * needs (billing-align.ts): collecting or paused, the interval in days, the
 * next charge.
 *
 * From the one cached read of the Stripe account every other billing screen
 * uses (billing-account.ts — ten minutes fresh, served stale for fifty more),
 * by the same ownership rules, so "this client's subscription" means here what
 * it means on Performance and on the client's record.
 *
 * NEVER HOLDS A PAGE UP. The client list, Client Health and the overview all
 * call this, and a COLD Stripe read (the first after a restart) takes tens of
 * seconds — measured: /roster stopped answering inside 25s once the list
 * waited for it. So the wait is capped: past `waitMs` the answer is null —
 * every caller then uses the dates on the record, exactly as before 14 Oct —
 * while the read carries on and fills the shared cache, so the next load
 * (a minute later at most, the list's own cache) has it at once.
 *
 * Null too when Stripe cannot be read at all.
 */
export const STRIPE_WAIT_MS = 4000;

function factsFrom(subscriptions: Awaited<ReturnType<typeof getAccountBilling>>["subscriptions"]) {
  const out = new Map<string, StripeSubscriptionFact[]>();
  for (const s of subscriptions) {
    if (!s.clientId) continue;
    const list = out.get(s.clientId) ?? [];
    list.push({ state: s.state, stepDays: s.stepDays, nextCharge: s.nextCharge });
    out.set(s.clientId, list);
  }
  return out;
}

export async function stripeFactsByClient(
  waitMs: number = STRIPE_WAIT_MS,
  read: typeof getAccountBilling = getAccountBilling,
): Promise<Map<string, StripeSubscriptionFact[]> | null> {
  const facts = read().then((b) => factsFrom(b.subscriptions));
  // Whatever happens after the cap is nobody's to handle but the cache's.
  facts.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([facts.catch(() => null), capped]);
  } finally {
    clearTimeout(timer);
  }
}
