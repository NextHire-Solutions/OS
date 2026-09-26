/*
 * What a status change does to billing — §9, §12, §21 steps 8 and 9.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION, AS GIVEN
 *
 *   "for paused/churned clients, subscription should be paused. it should not
 *    be canceled or deleted. just a simple subscription pause so that we can
 *    resume or reverse this action later"
 *
 * That is the whole rule, and the reason it is safe to automate at all. Every
 * other thing status propagation does is reversible — a paused campaign
 * unpauses, a closed portal reopens on the same token — and until now billing
 * was the one leg that could not join, because cancelling a Stripe
 * subscription cannot be undone. You create a NEW one, the billing anchor
 * moves, and the customer may be asked to pay again.
 *
 * Pausing collection is reversible in exactly the way the rest of the system
 * is: clear `pause_collection` and the subscription resumes on its original
 * anchor. So this module can pause and it can resume, and there is deliberately
 * NO code path here that cancels or deletes anything. That is not an oversight
 * to be filled in later; it is the instruction.
 *
 * ---------------------------------------------------------------------------
 * WHY `void` AND NOT `keep_as_draft`
 *
 * Stripe offers three pause behaviours. `keep_as_draft` accrues draft invoices
 * for the paused period and bills them on resume — so a client paused for two
 * months comes back to a two-month bill for a service they did not receive.
 * `void` issues nothing for the paused period, which is what "paused" means to
 * the business. Overridable per call for the case nobody has met yet.
 */

export type Lifecycle = "onboarding" | "active" | "paused" | "churned";

/** What Stripe says about the subscription right now. */
export interface SubscriptionState {
  /** Stripe's own status. Only `active` and `paused` are actionable. */
  status: string;
  /** True when `pause_collection` is already set. */
  paused: boolean;
}

export type BillingAction = "pause" | "resume" | "none";

export interface BillingDecision {
  action: BillingAction;
  /** Always populated — the screen and the audit log both show it. */
  reason: string;
}

/**
 * Decide, without touching anything.
 *
 * Pure so the rule can be read, tested and shown on screen without a Stripe
 * key in the room — and so a dry run is the same code as the real thing.
 */
export function planBillingAction(
  lifecycle: Lifecycle,
  sub: SubscriptionState | null,
): BillingDecision {
  if (!sub) return { action: "none", reason: "No subscription recorded for this client." };

  /*
   * A subscription Stripe has already ended is left alone in every direction.
   * Resuming it is impossible and pausing it is meaningless, and trying either
   * produces an API error that would make a status change look like it failed
   * when nothing is wrong.
   */
  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    return { action: "none", reason: `Subscription is ${sub.status}; nothing to pause or resume.` };
  }

  if (lifecycle === "paused" || lifecycle === "churned") {
    if (sub.paused) return { action: "none", reason: "Already paused." };
    return {
      action: "pause",
      reason: `Client is ${lifecycle} — collection paused, never cancelled, so it can be resumed.`,
    };
  }

  /*
   * Active AND onboarding both mean "should be collecting", per the rule as
   * given: "active/onboarding or added a new client -> active subscription".
   *
   * Onboarding does not behave like the portal leg here, which deliberately
   * leaves a portal untouched during setup. The difference is that an
   * onboarding client almost never HAS a subscription yet, so this is a no-op
   * in the ordinary case; where it is not — a client moved back into
   * onboarding whose collection was paused — resuming is what was asked for.
   */
  if (!sub.paused) return { action: "none", reason: "Already collecting." };
  return {
    action: "resume",
    reason: `Client is ${lifecycle} — collection resumed.`,
  };
}

export interface StripeCaller {
  (path: string, body: Record<string, string> | null): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Carry out a decision. Two calls exist in this file and neither can cancel:
 * one sets `pause_collection`, one clears it.
 */
export async function applyBillingAction(
  subscriptionId: string,
  decision: BillingDecision,
  call: StripeCaller,
  behaviour: "void" | "keep_as_draft" | "mark_uncollectible" = "void",
): Promise<{ ok: boolean; changed: boolean; error?: string }> {
  if (decision.action === "none") return { ok: true, changed: false };

  const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const body: Record<string, string> =
    decision.action === "pause"
      ? { "pause_collection[behavior]": behaviour }
      : { pause_collection: "" }; // empty clears it — Stripe's documented resume

  const res = await call(path, body);
  return { ok: res.ok, changed: res.ok, error: res.error };
}
