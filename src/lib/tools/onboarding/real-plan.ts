import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";

/*
 * The client's REAL plan and weekly target, for the Onboarding screens.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `orch_clients.plan` is the string 'production' for ALL 46 rows, and
 * `orch_clients.weekly_target` is the number 3 for all 46. They are the values
 * the intake form defaulted to and nobody ever updated. Measured 2026-09-24;
 * see docs/CLIENT-DATA-DICTIONARY.md.
 *
 * Client Health carries the real ones — 29 production / 7 partner / 14
 * minimum, and weekly targets ranging 1 to 4 — and it is the tool that bills
 * on them, which is what makes it the owner.
 *
 * So the pipeline screen was showing a "Production" badge against 21 clients
 * who are not on production. That is §13's "different client information
 * between platforms" in its most literal form: two screens, same client, two
 * answers, one of them a leftover.
 *
 * ---------------------------------------------------------------------------
 * RESOLVED THROUGH THE MASTER RECORD, NOT BY NAME
 *
 * orch_clients.id -> os_clients.orch_client_id -> os_clients.ch_client_id ->
 * client_health.clients. That is the chain the architecture spec describes:
 * a tool displaying a field it does not own, fetched from the record that
 * does. Matching on name here would reintroduce the exact fragility the
 * stored links were added to remove.
 *
 * Returns an empty map on any failure. The caller then shows what it showed
 * before, which is wrong but no worse than yesterday — a screen that fails to
 * load is worse than a screen with a stale badge.
 */

export interface RealPlan {
  plan: string | null;
  weeklyTarget: number | null;
}

export async function realPlansByOrchId(): Promise<Map<string, RealPlan>> {
  const out = new Map<string, RealPlan>();
  try {
    const { data: links, error } = await osTable("os_clients")
      .select("orch_client_id, ch_client_id")
      .not("orch_client_id", "is", null)
      .not("ch_client_id", "is", null)
      .limit(1000);
    if (error || !links?.length) return out;

    const pairs = (links as { orch_client_id: string; ch_client_id: string }[]).filter(
      (l) => l.orch_client_id && l.ch_client_id,
    );
    if (pairs.length === 0) return out;

    const { data: health, error: healthErr } = await getClientHealthDb()
      .from("clients")
      .select("id, plan, weekly_target")
      .in("id", [...new Set(pairs.map((p) => p.ch_client_id))]);
    if (healthErr || !health) return out;

    const byCh = new Map(
      (health as { id: string; plan: string | null; weekly_target: number | null }[]).map((h) => [
        h.id,
        { plan: h.plan ?? null, weeklyTarget: h.weekly_target ?? null },
      ]),
    );
    for (const p of pairs) {
      const real = byCh.get(p.ch_client_id);
      if (real) out.set(p.orch_client_id, real);
    }
  } catch {
    /* fall back to what the tool's own row says */
  }
  return out;
}
