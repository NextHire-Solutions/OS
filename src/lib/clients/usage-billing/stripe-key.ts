/*
 * Pay per lead's Stripe keys (26 Oct 2026; live clients 31 Oct).
 *
 * TEST CLIENTS use OS_USAGE_BILLING_STRIPE_KEY, which must be a Stripe TEST
 * key (sk_test_… or rk_test_…) — anything else is refused, thrown, before a
 * request exists. They never borrow the OS's shared key, which defaults to live.
 *
 * LIVE CLIENTS (the user, 31 Oct: "deploy and go" — Homebase and Premier Home
 * Team, billed per Interested lead) use the OS's own Stripe key, the one the
 * Billing tab reads with — and only when it is a LIVE key (sk_live_… or
 * rk_live_…). It is read in one file only, live-key.ts (a test pins that), and
 * only for a client whose settings row was made live on purpose, by a person,
 * with the client's card on file (billing.ts connectCard). The Stripe module
 * (stripe.ts) checks the key's mode again before every request and refuses an
 * answer from the other mode, so a test client can never reach live Stripe
 * and a live client can never be billed in test mode by mistake.
 */

export const USAGE_BILLING_KEY_ENV = "OS_USAGE_BILLING_STRIPE_KEY";

export type UsageMode = "test" | "live";

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9_]{8,}$/;
const LIVE_KEY = /^(sk|rk)_live_[A-Za-z0-9_]{8,}$/;

export class UsageBillingKeyError extends Error {
  readonly reason: "missing" | "not_test" | "not_live";
  constructor(reason: "missing" | "not_test" | "not_live", mode: UsageMode = "test") {
    super(
      reason === "not_live"
        ? "The OS's Stripe key is not a LIVE key, so a live client cannot be billed. Nothing was sent to Stripe."
        : reason === "not_test"
          ? `${USAGE_BILLING_KEY_ENV} is not a Stripe TEST key. Test clients are billed in Stripe test mode only.`
          : mode === "live"
            ? "The OS has no Stripe key, so a live client cannot be billed. Nothing was sent to Stripe."
            : `${USAGE_BILLING_KEY_ENV} is not set — pay per lead's test clients need a Stripe TEST key of their own.`,
    );
    this.name = "UsageBillingKeyError";
    this.reason = reason;
  }
}

/** True only for a Stripe TEST secret or restricted key. */
export function isTestKey(key: unknown): key is string {
  return typeof key === "string" && TEST_KEY.test(key);
}

/** True only for a Stripe LIVE secret or restricted key. */
export function isLiveKey(key: unknown): key is string {
  return typeof key === "string" && LIVE_KEY.test(key);
}

/** Returns the key when it is a test key; throws otherwise (never echoes the key). */
export function assertTestKey(key: unknown): string {
  if (typeof key !== "string" || !key) throw new UsageBillingKeyError("missing");
  if (!isTestKey(key)) throw new UsageBillingKeyError("not_test");
  return key;
}

/** Returns the key when it is a live key; throws otherwise (never echoes the key). */
export function assertLiveKey(key: unknown): string {
  if (typeof key !== "string" || !key) throw new UsageBillingKeyError("missing", "live");
  if (!isLiveKey(key)) throw new UsageBillingKeyError("not_live", "live");
  return key;
}

/** The key a mode needs, or a throw: `assertTestKey` for test, `assertLiveKey` for live. */
export function assertKeyFor(mode: UsageMode, key: unknown): string {
  return mode === "live" ? assertLiveKey(key) : assertTestKey(key);
}

/** The test clients' key, from OS_USAGE_BILLING_STRIPE_KEY — a TEST key, or it throws. */
export function usageBillingStripeKey(env: Record<string, string | undefined> = process.env): string {
  return assertTestKey(env[USAGE_BILLING_KEY_ENV]);
}

/** For the screen: whether a usable test key is configured (never the key). */
export function usageBillingKeyState(env: Record<string, string | undefined> = process.env): "test" | "missing" | "refused" {
  const k = env[USAGE_BILLING_KEY_ENV];
  if (!k) return "missing";
  return isTestKey(k) ? "test" : "refused";
}
