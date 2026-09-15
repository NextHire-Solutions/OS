import "server-only";

import { isConfigured } from "@/lib/env";
import { clientStatuses } from "@/lib/tools/client-health/publish";

import { getOnboardingDb } from "./db";
import { getSetting, setSetting } from "./settings";
import { indexTheirs, matchClient, type TheirClient } from "./health-match";

export * from "./health-match";

/**
 * Client status read back from the Health Dashboard.
 *
 * Their side owns the truth: `GET /api/clients/status` returns every client with
 * active | paused | churned. We only read it — nothing here writes to their
 * dashboard, and the status never drives any work. It is shown on the pipeline so
 * the team can see at a glance who is still live.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE STATUSES COME FROM
 *
 * The orchestrator read the live dashboard's GET /api/clients/status over
 * HTTP with HEALTH_DASH_BASE_URL + HEALTH_DASH_READ_TOKEN. Client Health is
 * being switched off and the workspace now holds the same database, so this
 * reads the same listing — identical shape, identical three-way status rule —
 * through `clientStatuses()` in lib/tools/client-health/publish.ts. Nothing
 * here writes to that database, and the status never drives any work.
 *
 * "Configured" therefore means Client Health's database credentials are set,
 * not a dashboard URL and token.
 */

const SYNCED_AT = "health_status_synced_at";

export interface HealthPanel {
  /** Statuses already stored on our rows, counted — never a live call. */
  counts: Record<string, number>;
  /** Clients with no status stored, by name. */
  unmatched: string[];
  lastSync: string | null;
  /** False when neither credential is set, so the screen can say so. */
  configured: boolean;
}

const DB_ENV = ["CLIENT_HEALTH_SUPABASE_URL", "CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY"];

function configured(): boolean {
  return isConfigured(...DB_ENV);
}

export async function fetchHealthStatuses(): Promise<{
  ok: boolean;
  error?: string;
  clients?: TheirClient[];
  counts?: Record<string, number>;
}> {
  if (!configured()) {
    return { ok: false, error: `${DB_ENV.join(" / ")} not set` };
  }

  try {
    const listing = await clientStatuses();
    return { ok: true, clients: listing.clients as TheirClient[], counts: listing.counts };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Pull every status and write it onto the matching clients.
 *
 * A client we cannot match is left alone rather than blanked — an unmatched name
 * is our problem to fix, not a reason to throw away the last status we knew.
 */
export async function syncHealthStatuses(): Promise<{
  ok: boolean;
  error?: string;
  matched: number;
  unmatched: string[];
}> {
  const r = await fetchHealthStatuses();
  if (!r.ok || !r.clients) return { ok: false, error: r.error, matched: 0, unmatched: [] };

  const db = getOnboardingDb();
  const { data: ours } = await db
    .from("orch_clients")
    .select("id, client_name, health_client_id, health_status");
  if (!ours) return { ok: false, error: "could not read clients", matched: 0, unmatched: [] };

  const index = indexTheirs(r.clients);
  const now = new Date().toISOString();
  const unmatched: string[] = [];
  let matched = 0;

  for (const c of ours as {
    id: string;
    client_name: string | null;
    health_client_id: string | null;
    health_status: string | null;
  }[]) {
    const theirs = matchClient(c, r.clients, index);
    if (!theirs) {
      unmatched.push(c.client_name ?? "(unnamed)");
      continue;
    }

    matched++;
    // Nothing to write: the status and the stored id both already agree.
    if (theirs.status === c.health_status && c.health_client_id === theirs.id) continue;
    await db
      .from("orch_clients")
      .update({ health_status: theirs.status, health_client_id: theirs.id, health_status_at: now })
      .eq("id", c.id);
  }

  await setSetting(SYNCED_AT, now);
  return { ok: true, matched, unmatched };
}

export async function lastHealthSync(): Promise<string | null> {
  return getSetting<string | null>(SYNCED_AT, null);
}

/**
 * What the Settings panel shows.
 *
 * Counts come from what we already stored, not a live call — Settings must
 * render even if the dashboard is down.
 */
export async function getHealthPanel(): Promise<HealthPanel> {
  const { data } = await getOnboardingDb().from("orch_clients").select("client_name, health_status");
  const counts: Record<string, number> = {};
  const unmatched: string[] = [];
  for (const r of (data ?? []) as { client_name: string | null; health_status: string | null }[]) {
    if (r.health_status) counts[r.health_status] = (counts[r.health_status] ?? 0) + 1;
    else unmatched.push(r.client_name ?? "(unnamed)");
  }
  return {
    counts,
    unmatched: unmatched.sort(),
    lastSync: await lastHealthSync().catch(() => null),
    configured: configured(),
  };
}
