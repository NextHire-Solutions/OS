import { NextResponse } from "next/server";

import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";
import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";
import {
  normalizeClientName,
  type ClientStatus,
} from "@/lib/tools/master-inbox/inbox/lists-shared";

export const dynamic = "force-dynamic";

/*
 * Which clients are active, paused or churned.
 *
 * Drives the coloured dot beside each client in the inbox's list rail.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS READS THE DATABASE RATHER THAN THE CLIENT HEALTH APP
 *
 * The tool's version proxies to Client Health's `/api/clients/status` with an
 * admin token. That made sense when the OS was a window onto five live
 * products. It does not now: Client Health is being switched off, and on the
 * day it goes the dots would silently stop appearing — the rail would still
 * render, every client would look the same, and nobody would know the health
 * signal had gone.
 *
 * The OS already reads Client Health's database directly for the weekly,
 * bi-weekly and success screens. Reading it here removes a dependency on an app
 * that is scheduled to disappear, and removes an admin token from the path.
 *
 * ---------------------------------------------------------------------------
 * THE STATUS RULES, AND WHERE THEY COME FROM
 *
 *   churned  hidden = true            (checked first — a churned client may
 *                                      also carry client_paused)
 *   paused   client_paused = true
 *   active   neither
 *
 * Verified against the live table: 48 clients → 35 active, 5 paused, 8 churned,
 * which matches what Client Health's own dashboard reports.
 *
 * ---------------------------------------------------------------------------
 * KEYED BY NORMALISED NAME
 *
 * Client Health and Master Inbox hold the same clients under different ids and
 * slightly different display names — "C21 Results - Elite Team" against "C21
 * Results Elite Team". Name is the only join key available, so both sides run
 * it through the tool's own `normalizeClientName`. Sharing that helper rather
 * than re-deriving it is what stops the two drifting apart.
 */

type StatusResponse = {
  ok: boolean;
  counts: Record<ClientStatus, number> | null;
  byName: Record<string, ClientStatus>;
};

const EMPTY: StatusResponse = { ok: false, counts: null, byName: {} };

/*
 * Five minutes. Health changes when somebody pauses or churns a client — a
 * deliberate, rare act — and every staff page load asks for this.
 */
const loadStatus = ttlCache(
  async (): Promise<StatusResponse> => {
    try {
      const { data, error } = await getClientHealthSupabase()
        .from("clients")
        .select("name, hidden, client_paused");

      if (error || !data) return EMPTY;

      const byName: Record<string, ClientStatus> = {};
      const counts: Record<ClientStatus, number> = { active: 0, paused: 0, churned: 0 };

      for (const row of data as Array<{ name: string | null; hidden: boolean | null; client_paused: boolean | null }>) {
        if (!row?.name) continue;
        const status: ClientStatus = row.hidden
          ? "churned"
          : row.client_paused
            ? "paused"
            : "active";
        byName[normalizeClientName(row.name)] = status;
        counts[status] += 1;
      }

      return { ok: true, counts, byName };
    } catch {
      /*
       * Fail open, deliberately. This decorates the rail; it must never be able
       * to break it. The caller gets ok:false and renders without dots.
       */
      return EMPTY;
    }
  },
  { ttlMs: 5 * 60_000 },
);

export async function GET() {
  return NextResponse.json(await loadStatus());
}
