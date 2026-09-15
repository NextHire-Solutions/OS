/*
 * The tool's Stripe key rule, without the network. `lib/stripe.ts`, read side
 * only — nothing here creates a price, a link or a charge.
 *
 * Both keys can live in the environment at once. STRIPE_MODE=test picks the
 * test key; anything else (or unset) uses the live key. So going live = set
 * STRIPE_MODE=live (or remove it) — no key juggling.
 */

export function pickStripeKey(env: { mode?: string; live?: string; test?: string }): string | null {
  const wantTest = (env.mode ?? "").toLowerCase() === "test";
  if (wantTest && env.test) return env.test;
  return env.live ?? env.test ?? null;
}

/** Which mode a key belongs to, read off its prefix — the badge that warns before a real charge. */
export function modeOfKey(key: string | null): "test" | "live" | "unknown" {
  if (!key) return "unknown";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return "unknown";
}

/** A Checkout Session, re-fetched from Stripe, that has actually been paid. */
export function isPaidSession(session: { payment_status?: unknown; status?: unknown } | null | undefined): boolean {
  return session?.payment_status === "paid" || session?.status === "complete";
}
