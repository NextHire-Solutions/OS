import "server-only";

import { stripeKey } from "@/lib/tools/onboarding/stripe";

import { applyBillingAction, stripeUrl } from "./stripe-billing";

/*
 * PAUSE / RESUME BILLING BY HAND — the button on a client's record (30 Sep).
 *
 * Status changes already pause and resume billing on their own
 * (status-propagate.ts); this is the same Stripe call, made on purpose by an
 * admin, for the cases the status does not cover. The same rules hold:
 *   · pause is Stripe's pause_collection with behaviour "void" — nothing is
 *     billed or accrues while paused — and NEVER a cancel
 *   · resume clears the pause; a cancelled subscription is refused, because
 *     only a new subscription can restart it
 */

export interface BillingState {
  subscriptionId: string;
  status: string;
  paused: boolean;
  /** Stripe's pause behaviour: void / keep_as_draft / mark_uncollectible. */
  behavior: string | null;
  amount: number | null;
  every: string | null;
  nextBilling: string | null;
}

export class BillingControlError extends Error {
  constructor(message: string) { super(message); this.name = "BillingControlError"; }
}

const day = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);

export async function readBilling(subscriptionId: string): Promise<BillingState> {
  const res = await fetch(stripeUrl(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=items.data.price`), {
    headers: { Authorization: `Bearer ${stripeKey()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const s = (await res.json().catch(() => null)) as {
    status?: string; pause_collection?: { behavior?: string } | null; current_period_end?: number;
    items?: { data?: { quantity?: number; current_period_end?: number; price?: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } } }[] };
    error?: { message?: string };
  } | null;
  if (!res.ok || !s?.status) throw new BillingControlError(s?.error?.message ?? `Stripe could not be read (HTTP ${res.status}).`);
  const it = s.items?.data?.[0];
  const r = it?.price?.recurring;
  return {
    subscriptionId,
    status: s.status,
    paused: Boolean(s.pause_collection),
    behavior: s.pause_collection?.behavior ?? null,
    amount: it?.price?.unit_amount != null ? (it.price.unit_amount / 100) * (it.quantity ?? 1) : null,
    every: r ? `${r.interval_count ?? 1} ${r.interval}${(r.interval_count ?? 1) === 1 ? "" : "s"}` : null,
    nextBilling: day(s.current_period_end ?? it?.current_period_end),
  };
}

/** Pause or resume. Reads first, so the refusal says exactly why; never cancels. */
export async function setBilling(subscriptionId: string, action: "pause" | "resume"): Promise<BillingState> {
  const now = await readBilling(subscriptionId);
  if (now.status === "canceled" || now.status === "incomplete_expired") {
    throw new BillingControlError(`This subscription is ${now.status} in Stripe, so it cannot be ${action}d. A new subscription is needed.`);
  }
  if (action === "pause" && now.paused) throw new BillingControlError("Billing is already paused.");
  if (action === "resume" && !now.paused) throw new BillingControlError("Billing is already collecting.");
  const key = stripeKey();
  const res = await applyBillingAction(subscriptionId, { action, reason: `${action}d by hand from the client's record` }, async (path, body) => {
    const r = await fetch(stripeUrl(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body ?? {}).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return { ok: true };
    const err = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { ok: false, error: err?.error?.message ?? `HTTP ${r.status}` };
  });
  if (!res.ok) throw new BillingControlError(`Stripe refused: ${res.error ?? "unknown error"}`);
  return readBilling(subscriptionId);
}
