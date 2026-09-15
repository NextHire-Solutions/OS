import "server-only";

import { optionalEnv } from "@/lib/env";

import { onboardingEnv } from "./env";
import { pickStripeKey } from "./stripe-pure";

/*
 * Stripe, READ SIDE ONLY.
 *
 * The tool's `lib/stripe.ts` also creates prices and payment links. That half
 * is deliberately not here: creating a payment link is switched off in the OS
 * pending explicit enablement (see step-run.ts). What remains is what the
 * Stripe webhook needs — re-fetch a Checkout Session with our own key to
 * confirm a payment event is genuine.
 */

const STRIPE = "https://api.stripe.com/v1";

export function stripeKey(): string {
  const k = pickStripeKey({
    mode: optionalEnv("ONBOARDING_STRIPE_MODE") ?? optionalEnv("STRIPE_MODE"),
    live: onboardingEnv("STRIPE_SECRET_KEY"),
    test: onboardingEnv("STRIPE_SECRET_KEY_TEST"),
  });
  if (!k) throw new Error("no Stripe key set (ONBOARDING_STRIPE_SECRET_KEY / ONBOARDING_STRIPE_SECRET_KEY_TEST)");
  return k;
}

/** Refetch a Checkout Session to confirm a webhook is genuine (no signing secret needed). */
export async function getCheckoutSession(id: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${STRIPE}/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${stripeKey()}` }, cache: "no-store",
  });
  return res.json().catch(() => null);
}
