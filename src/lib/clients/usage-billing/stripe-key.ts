/*
 * Pay per lead's Stripe key — TEST KEYS ONLY (26 Oct 2026).
 *
 * The user: "we do not want to make this live for any of the client right
 * now. we just need to build this and make a way to test this."
 *
 * So this feature does NOT use the OS's shared key (tools/onboarding/stripe.ts
 * `stripeKey()`): that picker DEFAULTS TO THE LIVE KEY (stripe-pure.ts
 * pickStripeKey — anything but STRIPE_MODE=test is live). It reads one
 * variable of its own, OS_USAGE_BILLING_STRIPE_KEY, and refuses — throws —
 * unless the key is a Stripe TEST key (sk_test_… or rk_test_…). The Stripe
 * module (stripe.ts) checks again before it builds any request, so a live key
 * can never reach Stripe through this feature, however it was passed in.
 *
 * GOING LIVE LATER IS A DELIBERATE CODE CHANGE THAT THE USER MUST APPROVE:
 * this file, its tests (stripe-key.test.ts), and the test-client rule in
 * model.ts (testBillingRefusal) all have to change on purpose. Setting an
 * environment variable is not enough, by design.
 */

export const USAGE_BILLING_KEY_ENV = "OS_USAGE_BILLING_STRIPE_KEY";

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9_]{8,}$/;

export class UsageBillingKeyError extends Error {
  readonly reason: "missing" | "not_test";
  constructor(reason: "missing" | "not_test") {
    super(
      reason === "missing"
        ? `${USAGE_BILLING_KEY_ENV} is not set — pay per lead needs a Stripe TEST key of its own.`
        : `${USAGE_BILLING_KEY_ENV} is not a Stripe TEST key. Pay per lead runs in test mode only; going live is a code change the user must approve.`,
    );
    this.name = "UsageBillingKeyError";
    this.reason = reason;
  }
}

/** True only for a Stripe TEST secret or restricted key. */
export function isTestKey(key: unknown): key is string {
  return typeof key === "string" && TEST_KEY.test(key);
}

/** Returns the key when it is a test key; throws otherwise (never echoes the key). */
export function assertTestKey(key: unknown): string {
  if (typeof key !== "string" || !key) throw new UsageBillingKeyError("missing");
  if (!isTestKey(key)) throw new UsageBillingKeyError("not_test");
  return key;
}

/** The feature's key, from OS_USAGE_BILLING_STRIPE_KEY — a TEST key, or it throws. */
export function usageBillingStripeKey(env: Record<string, string | undefined> = process.env): string {
  return assertTestKey(env[USAGE_BILLING_KEY_ENV]);
}

/** For the screen: whether a usable test key is configured (never the key). */
export function usageBillingKeyState(env: Record<string, string | undefined> = process.env): "test" | "missing" | "refused" {
  const k = env[USAGE_BILLING_KEY_ENV];
  if (!k) return "missing";
  return isTestKey(k) ? "test" : "refused";
}
