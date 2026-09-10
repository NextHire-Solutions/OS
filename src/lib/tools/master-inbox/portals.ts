import "server-only";

import { getMasterInboxSupabase } from "./supabase";

/*
 * Client portals — the staff view.
 *
 * What each client sees, and what they have done with it. This is the other
 * half of the introduction loop: staff label a thread, a trigger puts a row in
 * the client's portal, and the client moves it through their pipeline. This
 * screen is where staff can see that having happened.
 *
 * ---------------------------------------------------------------------------
 * STRICTLY READ-ONLY, AND MORE SO THAN ANYWHERE ELSE
 *
 * These are the tables the live portals are built on. A portal resolves only
 * while its client row exists with a token, `portal_enabled` not false, and a
 * slug that is not 'unknown' — 48 of them are answering right now.
 *
 * `portal-guard.ts` makes those four writes throw. Nothing here writes at all.
 *
 * ---------------------------------------------------------------------------
 * `clients` HAS NO workspace_id
 *
 * It is global to the deployment, which is why the portal token resolver looks
 * a token up with no workspace anywhere in its query. Filtering by one here
 * produced a 400 with an empty message on the settings screen and rendered as
 * "0 clients" until the error check caught it.
 */

type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export interface PortalClient {
  id: string;
  name: string;
  slug: string;
  /** Live means the token is set, the portal is enabled, and it is a real client. */
  live: boolean;
  enabled: boolean;
  hasToken: boolean;
  /** Whether a Follow Up Boss key is stored — never the key. */
  fubConnected: boolean;
  fubConnectedAt: string | null;
  /** Introductions in this client's pipeline, by stage. */
  byStage: Record<string, number>;
  total: number;
  /** The last time the CLIENT touched their own pipeline. */
  lastActivityAt: string | null;
  /** Introductions the workspace pushed that Follow Up Boss never accepted. */
  fubFailures: number;
}

export interface PortalsData {
  clients: PortalClient[];
  totalEntries: number;
  livePortals: number;
  error: string | null;
}

export async function getPortals(): Promise<PortalsData> {
  try {
    const sb = getMasterInboxSupabase();

    const [clientsRes, entriesRes] = await Promise.all([
      // fub_api_key is deliberately not selected — only whether one is set,
      // and that is decided on the server.
      sb.from("clients").select("id,name,slug,portal_enabled,portal_token,fub_connected_at").order("name"),
      sb.from("client_pipeline_entries")
        .select("client_id,stage,client_activity_at,fub_last_error")
        .limit(20_000),
    ]);

    for (const [what, res] of [["clients", clientsRes], ["pipeline entries", entriesRes]] as const) {
      if (res.error) throw new Error(`${what}: ${res.error.message}`);
    }

    const byClient = new Map<
      string,
      { byStage: Record<string, number>; total: number; last: string | null; failures: number }
    >();

    for (const e of rows(entriesRes.data)) {
      const id = str(e.client_id);
      if (!id) continue;
      const bucket = byClient.get(id) ?? { byStage: {}, total: 0, last: null, failures: 0 };
      const stage = str(e.stage) ?? "unknown";
      bucket.byStage[stage] = (bucket.byStage[stage] ?? 0) + 1;
      bucket.total += 1;
      const at = str(e.client_activity_at);
      if (at && (!bucket.last || at > bucket.last)) bucket.last = at;
      // A recorded push error means the lead never reached the client's CRM.
      if (str(e.fub_last_error)) bucket.failures += 1;
      byClient.set(id, bucket);
    }

    const clients: PortalClient[] = rows(clientsRes.data).map((c) => {
      const id = String(c.id);
      const b = byClient.get(id);
      const slug = String(c.slug ?? "");
      const hasToken = typeof c.portal_token === "string" && c.portal_token.length > 0;
      const enabled = c.portal_enabled !== false;
      return {
        id,
        name: String(c.name ?? "Unnamed"),
        slug,
        // The tool's own three conditions, in one place.
        live: hasToken && enabled && slug !== "unknown",
        enabled,
        hasToken,
        fubConnected: str(c.fub_connected_at) !== null,
        fubConnectedAt: str(c.fub_connected_at),
        byStage: b?.byStage ?? {},
        total: b?.total ?? 0,
        lastActivityAt: b?.last ?? null,
        fubFailures: b?.failures ?? 0,
      };
    });

    return {
      clients,
      totalEntries: rows(entriesRes.data).length,
      livePortals: clients.filter((c) => c.live).length,
      error: null,
    };
  } catch (error) {
    return {
      clients: [],
      totalEntries: 0,
      livePortals: 0,
      error: error instanceof Error ? error.message : "Client portals could not be read",
    };
  }
}
