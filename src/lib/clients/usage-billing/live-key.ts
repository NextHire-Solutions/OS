import "server-only";

import { stripeKey } from "@/lib/tools/onboarding/stripe";

import { assertLiveKey, UsageBillingKeyError } from "./stripe-key.ts";

/*
 * The ONE place pay per lead reads the OS's own Stripe key (31 Oct) — the key
 * the Billing tab reads, refunds and cancels with — for clients that have gone
 * live (stripe-key.ts). It must be a LIVE key: if the OS is switched to test
 * mode (STRIPE_MODE=test), a live client is not billed at all rather than
 * billed in the wrong mode. stripe-key.test.ts pins that no other pay-per-lead
 * file reads it.
 */
export function usageBillingLiveKey(): string {
  let key: string;
  try {
    key = stripeKey();
  } catch {
    throw new UsageBillingKeyError("missing", "live");
  }
  return assertLiveKey(key);
}
