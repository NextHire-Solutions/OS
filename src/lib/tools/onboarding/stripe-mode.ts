import "server-only";

import { optionalEnv } from "@/lib/env";

import { onboardingEnv } from "./env";
import { modeOfKey, pickStripeKey } from "./stripe-pure";

/**
 * Which Stripe mode the payment box should warn about.
 *
 * The orchestrator derives this from the prefix of the secret key it holds
 * (`sk_live_` / `sk_test_`). The workspace now holds the same keys under the
 * ONBOARDING_ prefix, so the same rule applies when one is set. Without a key
 * the mode is an env setting — ONBOARDING_STRIPE_MODE, falling back to
 * STRIPE_MODE — and anything other than "live" is test, the safe default for a
 * badge whose only job is to warn before a real charge.
 *
 * Read-only: nothing here, or anywhere in the OS, creates a charge or a link.
 */
export type StripeMode = "test" | "live";

export function stripeMode(): StripeMode {
  const raw = (optionalEnv("ONBOARDING_STRIPE_MODE") ?? optionalEnv("STRIPE_MODE") ?? "").toLowerCase();
  const fromKey = modeOfKey(pickStripeKey({
    mode: raw,
    live: onboardingEnv("STRIPE_SECRET_KEY"),
    test: onboardingEnv("STRIPE_SECRET_KEY_TEST"),
  }));
  if (fromKey !== "unknown") return fromKey;
  return raw === "live" ? "live" : "test";
}
