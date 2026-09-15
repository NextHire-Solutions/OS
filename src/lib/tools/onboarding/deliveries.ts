import "server-only";

import { getOnboardingDb } from "./db";

/*
 * The connector delivery log — `orch_connector_deliveries`.
 *
 * Every outbound call the tool makes is written here on success AND failure.
 * It is the table `step-state.ts` reads to draw the ✓, and the table every
 * once-only guard (`hasDelivery`) consults — so a send that does not log is a
 * send that will be made twice. Ported from the tool's `lib/deliveries.ts` and
 * the `log` helpers inside its connectors.
 */

export type DeliveryStatus = "ok" | "error" | "skipped" | "partial" | "pending";

export async function logDelivery(
  clientId: string,
  target: string,
  action: string,
  status: DeliveryStatus | string,
  request: unknown,
  response: unknown,
  error: string | null,
): Promise<void> {
  await getOnboardingDb().from("orch_connector_deliveries").insert({
    client_id: clientId, target, action, status,
    request: (request ?? null) as never, response: (response ?? null) as never, error,
  });
}

/** True when the client has a delivery for `target` with an action in `actions` (default: ok only). */
export async function hasDelivery(
  clientId: string, target: string, actions: string[], status = "ok",
): Promise<boolean> {
  const { count } = await getOnboardingDb().from("orch_connector_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId).eq("target", target).eq("status", status).in("action", actions);
  return (count ?? 0) > 0;
}

/** How many times has this action failed for the client? (for stuck-email alerts) */
export async function countFailures(clientId: string, target: string, action: string): Promise<number> {
  const { count } = await getOnboardingDb().from("orch_connector_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId).eq("target", target).eq("action", action).eq("status", "error");
  return count ?? 0;
}

/*
 * ---------------------------------------------------------------------------
 * PENDING ENABLEMENT
 *
 * Sending email to a client is switched off in the OS. Wherever the tool would
 * send one — the setup chain, the Calendly booking, the campaign launch, the
 * intro notifications, the follow-up — the workspace records THAT IT WOULD HAVE
 * rather than skipping in silence: a row with status "pending" and this
 * sentence in `error`. It is visible in the delivery log, it never counts as
 * done (only "ok" does), and it never counts as failed (only "error" does).
 *
 * One pending row per client and action: a chain re-run must not pile them up.
 */
export const PENDING_STATUS = "pending";
export const PENDING_ENABLEMENT = "switched off pending explicit enablement";

export interface PendingRecord {
  pending: true;
  target: string;
  action: string;
  /** False when a pending row for this action already existed. */
  recorded: boolean;
  error: string;
}

export async function recordPendingEmail(
  clientId: string,
  templateKey: string,
  opts: { target?: string; action?: string; via?: string; extra?: Record<string, unknown> } = {},
): Promise<PendingRecord> {
  const target = opts.target ?? "email";
  const action = opts.action ?? templateKey;
  const already = await hasDelivery(clientId, target, [action], PENDING_STATUS);
  if (!already) {
    await logDelivery(clientId, target, action, PENDING_STATUS,
      { would_send: templateKey, via: opts.via ?? "os", ...(opts.extra ?? {}) }, null, PENDING_ENABLEMENT);
  }
  return { pending: true, target, action, recorded: !already, error: PENDING_ENABLEMENT };
}
