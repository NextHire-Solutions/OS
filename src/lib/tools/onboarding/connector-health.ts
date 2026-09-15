import "server-only";

import { onboardClient } from "@/lib/tools/client-health/onboard";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";
import { getWeekly } from "@/lib/tools/client-health/weekly";

import { logDelivery } from "./deliveries";
import { healthDashBody } from "./connector-payloads";
import type { OrchClient } from "./orch-client";

/*
 * Step 2 — onboard the client into the Health Dashboard. The tool's
 * `pushToHealthDash` (lib/connectors/apps.ts).
 *
 * The tool POSTed to the live dashboard's /api/clients/onboard with
 * HEALTH_DASH_ADMIN_TOKEN. Client Health is the workspace's own now: the same
 * endpoint is served at /api/tools/client-health/clients/onboard (x-admin-token
 * CLIENT_HEALTH_ONBOARDING_TOKEN) and its logic — validation, the duplicate
 * guard, campaign auto-linking — lives in lib/tools/client-health/onboard.ts.
 * It is called in-process here, as lib/clients/onboard-run.ts does, for the
 * same reasons: the route sits behind the session proxy, and a loopback HTTP
 * call to yourself is a dependency on your own URL for no benefit.
 *
 * The delivery row is shaped as the route would answer — `{ client, linked }`
 * on success, the error body with `HTTP <status>` otherwise — so the log reads
 * the same whichever way the call was made. A 409 (already on the dashboard)
 * is an error here as it was against the live tool.
 */
export async function pushToHealthDash(c: OrchClient): Promise<void> {
  const body = healthDashBody(c);

  let db: ReturnType<typeof getClientHealthDb>;
  try {
    db = getClientHealthDb();
  } catch (e) {
    return logDelivery(c.id, "health_dash", "onboard_client", "skipped", body, null,
      `Client Health not configured: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const result = await onboardClient(db, body);
    if (!result.ok) {
      const { ok: _ok, status, ...rest } = result;
      return logDelivery(c.id, "health_dash", "onboard_client", "error", body, rest, `HTTP ${status}`);
    }
    // The 60-second read cache predates this row; drop it, as every write does.
    getWeekly.invalidate();
    return logDelivery(c.id, "health_dash", "onboard_client", "ok", body, result.value, null);
  } catch (e) {
    return logDelivery(c.id, "health_dash", "onboard_client", "error", body, null, e instanceof Error ? e.message : String(e));
  }
}
