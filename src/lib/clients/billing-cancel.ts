/*
 * Cancelling a client's subscription from the Billing tab (27 Oct). The user:
 * "can we add an option from where we can cancel the subscription? but please
 * make sure it asks for confirmation before doing this. and only eddy and amy
 * should be able to do this".
 *
 *   - Eddy and Amy only, by name (billing-access.ts) — not the rest of the
 *     Billing tab's people;
 *   - the client's CURRENT subscription (the one the tab shows), as Stripe has
 *     it now, not the tab's copy;
 *   - two ways: at the end of the period already paid for (Stripe stops
 *     before the next charge; it can be taken back until then — "Keep"), or
 *     immediately (no refund for the rest of the period; cannot be undone);
 *   - always a review first, then a confirmation, before Stripe is asked;
 *   - who did it is kept on the subscription (cancellation_details.comment,
 *     and metadata for a scheduled one) and in the OS log;
 *   - never twice: the confirmation's key goes to Stripe as the
 *     Idempotency-Key, and a subscription already cancelled, or already set to
 *     cancel, is answered as done rather than asked again.
 * It changes nothing else — not the client's status in the OS, not any portal.
 * Tested only in Stripe's TEST mode.
 */

import { z } from "zod";

type StripeErr = { error?: { message?: string } };

export const CANCEL_WHEN = { end: "At the end of the period", now: "Immediately" } as const;
export type CancelWhen = keyof typeof CANCEL_WHEN;

export const cancelRequest = z.object({
  clientId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  subscriptionId: z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/),
  /** cancel: stop it (`when`); keep: take back a cancellation set for the end of the period. */
  action: z.enum(["cancel", "keep"]),
  when: z.enum(["end", "now"]).default("end"),
  /** Made once per confirmation in the browser (Stripe's Idempotency-Key). */
  key: z.string().uuid(),
  /** true: read and check only — nothing is sent to Stripe. Required: a request that does not say is refused, never taken as "do it". */
  preview: z.boolean(),
});
export type CancelRequest = z.infer<typeof cancelRequest>;

export class CancelError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * A real cancellation (a live key) only from the deployed OS, asked for on
 * os.brokerstaffer.com itself — never from a copy running on a laptop, where
 * testing happens. Previews send nothing and are not held back.
 */
export function liveCancelRefusal(key: string, env: Record<string, string | undefined>, origin: string | null, site: string): string | null {
  if (!/^(sk|rk)_live_/.test(key)) return null;
  const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
  return onRailway && origin === site ? null : "Subscriptions are cancelled only from os.brokerstaffer.com.";
}

/** The subscription as Stripe has it NOW. */
export interface SubscriptionNow {
  id: string;
  status: string;
  /** Set to stop at the end of the period. */
  cancelAtPeriodEnd: boolean;
  /** When it stops (a set cancellation), seconds. */
  cancelAt: number | null;
  canceledAt: number | null;
  /** The end of the period already paid for, seconds. */
  periodEnd: number | null;
  /** Who set the cancellation from the OS, when it was the OS. */
  cancelledBy: string | null;
}

type RawSub = {
  id?: string; status?: string; cancel_at_period_end?: boolean; cancel_at?: number | null; canceled_at?: number | null;
  current_period_end?: number; trial_end?: number | null; metadata?: Record<string, string> | null;
  items?: { data?: Array<{ current_period_end?: number }> };
};

export function subscriptionFrom(j: RawSub): SubscriptionNow {
  return {
    id: j.id ?? "",
    status: j.status ?? "",
    cancelAtPeriodEnd: !!j.cancel_at_period_end,
    cancelAt: j.cancel_at ?? null,
    canceledAt: j.canceled_at ?? null,
    periodEnd: j.items?.data?.[0]?.current_period_end ?? j.current_period_end ?? (j.status === "trialing" ? j.trial_end ?? null : null),
    cancelledBy: j.metadata?.os_cancel_by || null,
  };
}

export async function subscriptionNow(key: string, id: string, f: typeof fetch = fetch): Promise<SubscriptionNow> {
  const res = await f(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  const j = (await res.json().catch(() => null)) as (RawSub & StripeErr) | null;
  if (res.status === 404) throw new CancelError("Stripe has no such subscription.", 404);
  if (!res.ok || !j?.id) throw new CancelError(`Stripe: ${j?.error?.message ?? `HTTP ${res.status}`}`, 502);
  return subscriptionFrom(j);
}

const ENDED = new Set(["canceled", "incomplete_expired"]);
/** Running and billed by period — what "at the end of the period" means anything for. */
const PERIODIC = new Set(["active", "trialing", "past_due", "unpaid"]);

/** What will happen — or why not, or that it has happened already. */
export type CancelPlan =
  | { kind: "send"; endsAt: number | null }
  | { kind: "done"; message: string; endsAt: number | null };

/** The checks before Stripe is asked, on the subscription as Stripe has it now. */
export function planCancel(s: SubscriptionNow, action: CancelRequest["action"], when: CancelWhen): CancelPlan {
  const ended = ENDED.has(s.status);
  if (action === "keep") {
    if (ended) throw new CancelError("This subscription has already ended — it cannot be kept. A new one would have to be created.", 409);
    if (!s.cancelAtPeriodEnd && !s.cancelAt) return { kind: "done", message: "This subscription is not set to cancel, so there is nothing to take back.", endsAt: null };
    return { kind: "send", endsAt: null };
  }
  if (ended) return { kind: "done", message: "This subscription is already cancelled.", endsAt: s.canceledAt };
  if (when === "end") {
    if (s.cancelAtPeriodEnd || s.cancelAt) return { kind: "done", message: "This subscription is already set to cancel.", endsAt: s.cancelAt ?? s.periodEnd };
    if (!PERIODIC.has(s.status) || !s.periodEnd) throw new CancelError(`A ${s.status.replace(/_/g, " ")} subscription has no paid period to run to — cancel it immediately instead.`, 409);
    return { kind: "send", endsAt: s.periodEnd };
  }
  return { kind: "send", endsAt: null };
}

/** The comment Stripe keeps on the cancellation, and shows on the subscription. */
export const cancelComment = (who: string, when: CancelWhen) =>
  `Cancelled ${when === "end" ? "at the end of the period" : "immediately"} from the BrokerStaffer OS by ${who}.`;

/** The request Stripe gets, for one cancellation or one Keep. */
export function cancelCall(r: Pick<CancelRequest, "subscriptionId" | "action" | "when" | "clientId" | "key">, who: string): { method: "POST" | "DELETE"; path: string; form: URLSearchParams } {
  const path = `subscriptions/${encodeURIComponent(r.subscriptionId)}`;
  const form = new URLSearchParams();
  if (r.action === "keep") {
    // Clears a custom cancel date set in Stripe's dashboard too (proven in TEST mode, 27 Oct). Stripe refuses cancel_at alongside it.
    form.set("cancel_at_period_end", "false");
    // Clears what a scheduled cancellation left (Stripe drops a key set to "").
    form.set("cancellation_details[comment]", "");
    form.set("metadata[os_cancel_by]", "");
    form.set("metadata[os_cancel_key]", "");
    form.set("metadata[os_cancel_client]", "");
    form.set("metadata[os_kept_by]", who);
    return { method: "POST", path, form };
  }
  form.set("cancellation_details[comment]", cancelComment(who, r.when));
  if (r.when === "end") {
    form.set("cancel_at_period_end", "true");
    form.set("metadata[os_cancel_by]", who);
    form.set("metadata[os_cancel_key]", r.key);
    // NOT os_client_id: that key makes the Billing tab's ownership rules read the subscription as "created by the OS" for this client.
    form.set("metadata[os_cancel_client]", r.clientId);
    return { method: "POST", path, form };
  }
  // Immediately: no invoice for the time used, no proration credit — Stripe's defaults, said out loud.
  form.set("invoice_now", "false");
  form.set("prorate", "false");
  return { method: "DELETE", path, form };
}

export async function sendCancel(key: string, r: CancelRequest, who: string, f: typeof fetch = fetch): Promise<SubscriptionNow> {
  const call = cancelCall(r, who);
  const res = await f(`https://api.stripe.com/v1/${call.path}`, {
    method: call.method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `os-sub-${r.action}-${r.action === "cancel" ? r.when : "keep"}-${r.key}`,
    },
    body: call.form.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => null)) as (RawSub & StripeErr) | null;
  if (!res.ok || !j?.id) {
    /*
     * Stripe ignores an Idempotency-Key on DELETE, and answers a second
     * cancellation of an ended subscription "No such subscription" (seen in
     * TEST mode, 27 Oct). Two confirmations racing each other — the second
     * finds it already ended: that is the answer, not an error.
     */
    if (r.action === "cancel" && r.when === "now") {
      const s = await subscriptionNow(key, r.subscriptionId, f).catch(() => null);
      if (s && ENDED.has(s.status)) return s;
    }
    throw stripeRefusal(res.status, j?.error?.message);
  }
  return subscriptionFrom(j);
}

/*
 * Stripe said no, in a way that means nothing changed — or gave no clear
 * answer (502: the person is told it may have gone through).
 */
export function stripeRefusal(status: number, message: string | undefined): CancelError {
  if (status === 400 || status === 402 || status === 404) return new CancelError(`Stripe: ${message ?? `HTTP ${status}`}`, 409);
  if (status === 429) return new CancelError("Stripe is busy right now. Nothing was changed — try again in a minute.", 503);
  if (status === 401 || status === 403) return new CancelError("Stripe refused the OS's key. Nothing was changed.", 503);
  return new CancelError(`Stripe: ${message ?? `HTTP ${status}`}`, 502);
}

/** Whether Stripe now has what was asked — checked before saying it worked. */
export function landed(s: SubscriptionNow, r: Pick<CancelRequest, "action" | "when">): boolean {
  if (r.action === "keep") return !s.cancelAtPeriodEnd && !s.cancelAt && !ENDED.has(s.status);
  if (r.when === "now") return ENDED.has(s.status);
  return ENDED.has(s.status) || s.cancelAtPeriodEnd || !!s.cancelAt;
}

export const isEnded = (s: SubscriptionNow) => ENDED.has(s.status);
