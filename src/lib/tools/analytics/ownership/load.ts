import "server-only";

import { masterByToolId } from "@/lib/clients/master-lookup";
import { ttlCache } from "@/lib/cache/ttl";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

import { ownersFromDatabase } from "./suggest";

/*
 * The Database's campaign owners, keyed for Analytics. See suggest.ts for why
 * these are offered rather than written.
 *
 * Two reads, both small: the per-client campaign lists come from
 * os_client_campaign_stats() (Database migration 0123), which aggregates the
 * ~440k lead rows in the database; bison_campaigns is 257 rows. EmailBison
 * campaigns are keyed by their NUMBER — raw->>'id' — which is what Analytics'
 * campaigns.id holds (the column is EmailBison's UUID).
 */
async function load(): Promise<Map<string, string>> {
  const sb = getCorofySupabase();
  const [stats, bison, master] = await Promise.all([
    sb.rpc("os_client_campaign_stats"),
    sb.from("bison_campaigns").select("num:raw->>id, orch_client_id").not("orch_client_id", "is", null).limit(5000),
    masterByToolId("database"),
  ]);
  if (stats.error) throw new Error(`os_client_campaign_stats: ${stats.error.message}`);
  if (bison.error) throw new Error(`bison_campaigns: ${bison.error.message}`);

  const byClient = new Map<string, { id: string; provider: string }[]>();
  for (const r of (stats.data ?? []) as { client_id: string; campaigns: { id: string; provider: string }[] | null }[]) {
    byClient.set(r.client_id, (r.campaigns ?? []).map((c) => ({ id: String(c.id), provider: String(c.provider) })));
  }
  const bisonOwner = new Map<string, string>();
  for (const r of (bison.data ?? []) as unknown as { num: string | null; orch_client_id: string }[]) {
    if (r.num) bisonOwner.set(String(r.num), r.orch_client_id);
  }
  return ownersFromDatabase({ byClient, bisonOwner }, (dbId) => master.get(dbId)?.links.analytics ?? null);
}

/** Campaign key (see keyOf) → Analytics client id. Empty on failure — the screen then just offers no suggestion. */
export const databaseOwnersForAnalytics = ttlCache(
  () => load().catch((e) => { console.error("[analytics] database owners:", e instanceof Error ? e.message : e); return new Map<string, string>(); }),
  { ttlMs: 60_000, key: () => "owners" },
);
