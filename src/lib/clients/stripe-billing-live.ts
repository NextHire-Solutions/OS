import "server-only";

import { optionalEnv } from "@/lib/env";
import { stripeKey } from "@/lib/tools/onboarding/stripe";
import {
  applyBillingAction,
  planBillingAction,
  type BillingDecision,
  type Lifecycle,
  type SubscriptionState,
} from "./stripe-billing";

/*
 * The billing leg's hands. The rule itself is in `stripe-billing.ts` and stays
 * pure; this file is the only place that talks to Stripe.
 *
 * The key comes from `stripeKey()`, which the onboarding tool already uses —
 * one Stripe credential for the workspace, one mode switch (STRIPE_MODE), and
 * no second opinion about which key is live.
 *
 * ---------------------------------------------------------------------------
 * OFF UNLESS TURNED ON
 *
 * OS_STRIPE_BILLING_ENABLED=1, for the same reason every scheduler here is
 * gated: a preview deployment or a local checkout holding production
 * credentials must never reach into a real Stripe account. Unset, the leg
 * reports itself skipped and touches nothing.
 */

const STRIPE = "https://api.stripe.com/v1";

export function billingEnabled(): boolean {
  return optionalEnv("OS_STRIPE_BILLING_ENABLED") === "1";
}

/** Read the subscription's current state. Null when Stripe does not know it. */
async function readSubscription(id: string, key: string): Promise<SubscriptionState | null> {
  const res = await fetch(`${STRIPE}/subscriptions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as
    | { status?: string; pause_collection?: unknown }
    | null;
  if (!body?.status) return null;
  return { status: body.status, paused: Boolean(body.pause_collection) };
}

export interface BillingOutcome {
  /** False only when Stripe refused; a no-op is a success. */
  ok: boolean;
  changed: boolean;
  decision: BillingDecision;
  error?: string;
}

/**
 * Bring one client's subscription into line with its status.
 *
 * Reads Stripe first rather than trusting a stored flag: the subscription may
 * have been paused or resumed in the dashboard since we last looked, and
 * acting on a stale idea of its state is how you pause something twice or
 * resume something a person deliberately stopped.
 */
export async function syncBillingForClient(
  subscriptionId: string | null,
  lifecycle: Lifecycle,
): Promise<BillingOutcome> {
  if (!subscriptionId) {
    const decision = planBillingAction(lifecycle, null);
    return { ok: true, changed: false, decision };
  }

  let key: string;
  try {
    key = stripeKey();
  } catch (e) {
    return {
      ok: false,
      changed: false,
      decision: { action: "none", reason: "Stripe is not configured." },
      error: e instanceof Error ? e.message : "no Stripe key",
    };
  }

  let state: SubscriptionState | null;
  try {
    state = await readSubscription(subscriptionId, key);
  } catch (e) {
    return {
      ok: false,
      changed: false,
      decision: { action: "none", reason: "Could not read the subscription." },
      error: e instanceof Error ? e.message : "Stripe read failed",
    };
  }
  if (!state) {
    return {
      ok: false,
      changed: false,
      decision: { action: "none", reason: "Stripe does not recognise this subscription." },
      error: `subscription ${subscriptionId} not found`,
    };
  }

  const decision = planBillingAction(lifecycle, state);
  const res = await applyBillingAction(subscriptionId, decision, async (path, body) => {
    try {
      const r = await fetch(`${STRIPE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body ?? {}).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ok: true };
      const err = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
      return { ok: false, error: err?.error?.message ?? `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Stripe call failed" };
    }
  });

  return { ok: res.ok, changed: res.changed, decision, error: res.error };
}
