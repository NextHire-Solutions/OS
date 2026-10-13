import "server-only";

import { masterByToolId, marketsLine, type MasterFacts } from "@/lib/clients/master-lookup";
import type { ClientStatus } from "@/lib/clients/client-status";
import { ttlCache } from "@/lib/cache/ttl";

import { getCorofySupabase } from "../corofy/supabase";
import { bisonCampaignKey, mergeCampaigns, type DbCampaign } from "./campaigns";

export type { DbCampaign };

/*
 * THE DATABASE VIEW — §8's list for the Database tool, inside the OS.
 *
 *   Client · Client status · MLS/location · Campaign · Campaign ID · Leads ·
 *   Sequencers · Replies · Bounces
 *
 * (In Review, Exported and Onboarding status were the last three columns until
 * 13 Oct. All three were written only by the Onboarding flow, which was retired
 * on 9 Oct, so they had stopped meaning anything — OS feedback: "Remove all
 * fields, columns, data related to onboarding status" and, of the two flags,
 * "if we do not use these, kill it". Nothing is deleted from the Database; the
 * OS simply no longer reads them.)
 *
 * The standalone Database app shows these on its Clients page (/webhooks). It
 * is being retired, so the OS has to show them itself, from the same rows.
 *
 * ---------------------------------------------------------------------------
 * WHERE EACH FIELD COMES FROM
 *
 *   Client, Client status, MLS/location   the master record (§5), falling back
 *                                         to the Database's own row
 *   Campaign, Campaign ID                 bison_campaigns (EmailBison, by
 *                                         orch_client_id) plus every campaign
 *                                         holding the client's leads — the only
 *                                         record of Instantly campaigns
 *   Leads, Sequencers, Replies, Bounces   os_client_campaign_stats(): the SAME
 *                                         counts as the Database app's page
 *
 * The sequencer counts are aggregated IN the database by one function
 * (migration 0123 in the Database repo). The view behind them holds ~440k
 * rows; read over the REST API it would be ~440 pages per load. Until that
 * function exists those four counts are null and the screen says why —
 * Leads alone falls back to a paged count, since its table is small.
 */

export interface DatabaseClient {
  id: string;
  name: string;
  masterId: string | null;
  status: ClientStatus | null;
  /** The Database's own lifecycle value — shown only when there is no master record. */
  toolStatus: string | null;
  location: string | null;
  campaigns: DbCampaign[];
  leads: number;
  inSequencers: number | null;
  matched: number | null;
  replied: number | null;
  bounced: number | null;
  createdAt: string | null;
}

export interface DatabaseClientsView {
  clients: DatabaseClient[];
  /** False until migration 0123 has been run — the screen explains the blanks. */
  statsAvailable: boolean;
  campaignsSyncedAt: string | null;
  loadedAt: string;
}

type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : v == null ? null : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

async function paged(table: string, cols: string): Promise<Row[]> {
  const sb = getCorofySupabase();
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...rows(data));
    if (rows(data).length < 1000) break;
  }
  return out;
}

interface Stats {
  leads: number;
  inSequencers: number;
  matched: number;
  replied: number;
  bounced: number;
  campaigns: { id: string; name: string; provider: string }[];
}

/** The function's rows, or null when it has not been created yet. */
async function loadStats(): Promise<Map<string, Stats> | null> {
  const { data, error } = await getCorofySupabase().rpc("os_client_campaign_stats");
  if (error) {
    // PGRST202: function not found. Anything else is a real failure.
    if (error.code === "PGRST202" || /could not find the function/i.test(error.message)) return null;
    throw new Error(`os_client_campaign_stats: ${error.message}`);
  }
  const out = new Map<string, Stats>();
  for (const r of rows(data)) {
    out.set(String(r.client_id), {
      leads: num(r.leads),
      inSequencers: num(r.in_sequencers),
      matched: num(r.matched),
      replied: num(r.replied),
      bounced: num(r.bounced),
      campaigns: rows(r.campaigns).map((c) => ({ id: String(c.id ?? ""), name: String(c.name ?? ""), provider: String(c.provider ?? "") })),
    });
  }
  return out;
}

async function load(): Promise<DatabaseClientsView> {
  const sb = getCorofySupabase();
  const [clientsRes, bisonRes, stats, master, synced] = await Promise.all([
    sb
      .from("orch_clients")
      .select(
        "id,client_name,brand,office_name,status,mls,location,bison_campaign_id,created_at",
      )
      .order("client_name"),
    paged("bison_campaigns", "bison_campaign_id,bison_number:raw->>id,name,status,orch_client_id"),
    loadStats(),
    masterByToolId("database").catch(() => new Map<string, MasterFacts>()),
    sb.from("bison_campaigns").select("fetched_at").order("fetched_at", { ascending: false }).limit(1),
  ]);
  if (clientsRes.error) throw new Error(`orch_clients: ${clientsRes.error.message}`);

  const bisonByClient = new Map<string, { id: string; uuid: string | null; name: string; status: string | null }[]>();
  for (const b of bisonRes) {
    const cid = str(b.orch_client_id);
    if (!cid) continue;
    const list = bisonByClient.get(cid) ?? [];
    list.push({
      id: bisonCampaignKey(b.bison_number, b.bison_campaign_id),
      uuid: str(b.bison_campaign_id),
      name: String(b.name ?? ""),
      status: str(b.status),
    });
    bisonByClient.set(cid, list);
  }

  // Leads without the function: the table is small enough to page.
  let leadsFallback: Map<string, number> | null = null;
  if (!stats) {
    leadsFallback = new Map();
    for (const r of await paged("orch_client_leads", "client_id")) {
      const k = String(r.client_id);
      leadsFallback.set(k, (leadsFallback.get(k) ?? 0) + 1);
    }
  }

  const clientRows = rows(clientsRes.data);

  const clients: DatabaseClient[] = clientRows.map((c) => {
    const id = String(c.id);
    const m = master.get(id);
    const s = stats?.get(id);
    return {
      id,
      name: m?.name ?? str(c.client_name) ?? str(c.brand) ?? str(c.office_name) ?? "Unnamed",
      masterId: m?.id ?? null,
      status: m?.status ?? null,
      toolStatus: str(c.status),
      location: (m && marketsLine(m.markets)) ?? ([str(c.mls), str(c.location)].filter(Boolean).join(" · ") || null),
      campaigns: mergeCampaigns(bisonByClient.get(id) ?? [], s?.campaigns ?? [], str(c.bison_campaign_id), stats !== null),
      leads: s ? s.leads : leadsFallback?.get(id) ?? 0,
      inSequencers: s ? s.inSequencers : null,
      matched: s ? s.matched : null,
      replied: s ? s.replied : null,
      bounced: s ? s.bounced : null,
      createdAt: str(c.created_at),
    };
  });

  return {
    clients,
    statsAvailable: stats !== null,
    campaignsSyncedAt: str(rows(synced.data)[0]?.fetched_at),
    loadedAt: new Date().toISOString(),
  };
}

export const loadDatabaseClients = ttlCache(load, { ttlMs: 30_000, key: () => "database-clients" });
