import "server-only";

import { getSupabase as getHealthSupabase } from "@/lib/tools/client-health/supabase";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { publicPortalUrl } from "@/lib/tools/master-inbox/portals/public-url";

import { deriveClientIdFromCampaign } from "@/lib/tools/master-inbox/clients/derive";

import { autoPortal, majority, type AutoHints } from "./campaign-portal-plan";
import { getMasterClientList, type MasterClient } from "./master-list";
import { miRowsFor } from "./mi-status-mirror";
import { osTable } from "./os-db";

/*
 * WHICH PORTAL EACH CAMPAIGN FEEDS (1 Oct) — for clients with several portals.
 *
 * Master Inbox sorts a reply into a portal when the reply first arrives, and
 * a thread keeps that portal for good ("first match wins"). It used to decide
 * by guessing from the campaign's name; it now reads os_campaign_portals
 * first (lib/tools/master-inbox/clients/derive.ts, and the same change in the
 * standalone app, which is the one receiving the webhooks today).
 *
 *   assignAutoRoutes  — for every campaign of a multi-portal client that has
 *                       no row yet, save the automatic choice ONCE (source
 *                       'auto'). Existing rows are never touched.
 *   setCampaignPortal — a person's choice (source 'manual').
 *   campaignPortalView — what the client record shows. Reads only.
 *
 * Only NEW replies follow a choice. Leads a campaign already delivered stay in
 * the portal they are in (user decision, 1 Oct).
 */

export type Platform = "emailbison" | "instantly";

export interface PortalOption {
  id: string;
  name: string;
  url: string | null;
  enabled: boolean;
  main: boolean;
}

export interface CampaignRoute {
  platform: Platform;
  /** As threads.campaign_id holds it: EmailBison's number, Instantly's UUID. Null when unknown. */
  campaignId: string | null;
  name: string;
  status: string | null;
  portalId: string | null;
  /** 'auto' / 'manual' once saved; null while not saved yet. */
  source: "auto" | "manual" | null;
  decidedBy: string | null;
  /** For an unsaved campaign: the automatic choice it will get, and why. */
  suggestion: { portalId: string; reason: string } | null;
}

export interface CampaignPortalView {
  /** False until migrations/0025 has been run. */
  ready: boolean;
  multi: boolean;
  portals: PortalOption[];
  campaigns: CampaignRoute[];
}

export class CampaignPortalError extends Error {
  constructor(message: string) { super(message); this.name = "CampaignPortalError"; }
}

const MIGRATION = "Choosing a portal per campaign needs migrations/0025_campaign_portals.sql run in the Master Inbox Supabase project.";

type RouteRow = { platform: Platform; campaign_id: string; campaign_name: string | null; os_client_id: string; mi_client_id: string; source: "auto" | "manual"; decided_by: string | null };

async function readRoutes(osClientId?: string): Promise<RouteRow[] | null> {
  let q = osTable("os_campaign_portals").select("platform, campaign_id, campaign_name, os_client_id, mi_client_id, source, decided_by");
  if (osClientId) q = q.eq("os_client_id", osClientId);
  const { data, error } = await q;
  if (error) return null; // before 0025
  return (data ?? []) as unknown as RouteRow[];
}

async function portalsOf(c: MasterClient, miClientId: string | null): Promise<PortalOption[]> {
  const ids = await miRowsFor({ id: c.id, name: c.name, aliases: c.aliases, miClientId });
  if (!ids.length) return [];
  const { data, error } = await getMasterInboxSupabase().from("clients").select("id, name, portal_token, portal_enabled").in("id", ids);
  if (error) throw new Error(`Master Inbox portals: ${error.message}`);
  return ((data ?? []) as { id: string; name: string; portal_token: string | null; portal_enabled: boolean | null }[])
    .map((r) => ({ id: r.id, name: r.name, url: publicPortalUrl(r.portal_token), enabled: r.portal_enabled !== false, main: r.id === miClientId }))
    .sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));
}

/** EmailBison campaigns reach the OS by UUID; threads carry EmailBison's number. */
async function bisonNumbers(uuids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!uuids.length) return out;
  const { data, error } = await getHealthSupabase().from("bison_campaigns").select("id, int_id").in("id", uuids);
  if (error) throw new Error(`Client Health campaigns: ${error.message}`);
  for (const r of (data ?? []) as { id: string; int_id: number | string | null }[]) {
    if (r.int_id != null && String(r.int_id).trim()) out.set(r.id, String(r.int_id));
  }
  return out;
}

async function clientAndPortals(osClientId: string) {
  const list = await getMasterClientList();
  const c = list.clients.find((x) => x.id === osClientId);
  if (!c) throw new CampaignPortalError("No such client.");
  const { data: row, error } = await osTable("os_clients").select("mi_client_id").eq("id", osClientId).maybeSingle();
  if (error) throw new Error(error.message);
  const miClientId = (row as { mi_client_id: string | null } | null)?.mi_client_id ?? null;
  const portals = await portalsOf(c, miClientId);
  return { c, portals, mainId: miClientId && portals.some((p) => p.id === miClientId) ? miClientId : portals[0]?.id ?? null };
}

async function campaignsOf(c: MasterClient): Promise<{ platform: Platform; campaignId: string | null; name: string; status: string | null }[]> {
  const list = c.campaigns ?? [];
  const numbers = await bisonNumbers(list.filter((x) => x.platform === "EmailBison").map((x) => x.id));
  return list.map((x) => x.platform === "EmailBison"
    ? { platform: "emailbison" as const, campaignId: numbers.get(x.id) ?? null, name: x.name, status: x.status }
    : { platform: "instantly" as const, campaignId: x.id, name: x.name, status: x.status });
}

/** Where a campaign's replies go today, and where the name guess would send a new one. */
async function hintsFor(x: { platform: Platform; campaignId: string | null; name: string }): Promise<AutoHints> {
  const [replies, guess] = await Promise.all([
    x.campaignId
      ? getMasterInboxSupabase().from("threads").select("client_id").eq("campaign_id", x.campaignId).eq("source_provider", x.platform).limit(1000)
          .then(({ data, error }) => (error ? null : majority(((data ?? []) as { client_id: string | null }[]).map((t) => t.client_id))))
      : Promise.resolve(null),
    // Name only — no campaign id — so this is the guess, never a saved choice.
    deriveClientIdFromCampaign(x.name).catch(() => null),
  ]);
  return { replies, guess };
}

export async function campaignPortalView(osClientId: string): Promise<CampaignPortalView> {
  const { c, portals, mainId } = await clientAndPortals(osClientId);
  const multi = portals.length > 1;
  const routes = await readRoutes(osClientId);
  const saved = new Map((routes ?? []).map((r) => [`${r.platform}:${r.campaign_id}`, r]));
  const campaigns = await Promise.all((await campaignsOf(c)).map(async (x): Promise<CampaignRoute> => {
    const r = x.campaignId ? saved.get(`${x.platform}:${x.campaignId}`) : undefined;
    const suggestion = multi && mainId && !r && x.campaignId ? autoPortal(x.name, portals, [c.name], mainId, await hintsFor(x)) : null;
    return { ...x, portalId: r?.mi_client_id ?? null, source: r?.source ?? null, decidedBy: r?.decided_by ?? null, suggestion };
  }));
  return { ready: routes !== null, multi, portals, campaigns };
}

/**
 * Save the automatic choice for every campaign that has none — once. Rows
 * that exist (automatic or chosen by a person) are never changed. Clients
 * with one portal are skipped: they need no choice.
 */
export async function assignAutoRoutes(osClientId?: string): Promise<{ assigned: number; ready: boolean }> {
  const routes = await readRoutes();
  if (routes === null) return { assigned: 0, ready: false };
  const have = new Set(routes.map((r) => `${r.platform}:${r.campaign_id}`));
  const list = await getMasterClientList();
  let assigned = 0;
  for (const c of list.clients) {
    if (osClientId && c.id !== osClientId) continue;
    if (!c.campaigns?.length) continue;
    const { portals, mainId } = await clientAndPortals(c.id);
    if (portals.length < 2 || !mainId) continue;
    const rows = await Promise.all((await campaignsOf(c))
      .filter((x) => x.campaignId && !have.has(`${x.platform}:${x.campaignId}`))
      .map(async (x) => ({
        platform: x.platform, campaign_id: x.campaignId as string, campaign_name: x.name,
        os_client_id: c.id, mi_client_id: autoPortal(x.name, portals, [c.name], mainId, await hintsFor(x)).portalId, source: "auto" as const,
      })));
    if (!rows.length) continue;
    // ignoreDuplicates: a row saved meanwhile (by a person, or another pass) wins.
    const { data, error } = await osTable("os_campaign_portals")
      .upsert(rows, { onConflict: "platform,campaign_id", ignoreDuplicates: true }).select("campaign_id");
    if (error) throw new Error(error.message);
    assigned += (data ?? []).length;
    for (const r of rows) have.add(`${r.platform}:${r.campaign_id}`);
  }
  return { assigned, ready: true };
}

export async function setCampaignPortal(osClientId: string, platform: Platform, campaignId: string, portalId: string, by: string): Promise<void> {
  const { c, portals } = await clientAndPortals(osClientId);
  if (portals.length < 2) throw new CampaignPortalError(`${c.name} has one portal; every campaign already goes to it.`);
  if (!portals.some((p) => p.id === portalId)) throw new CampaignPortalError("That portal does not belong to this client.");
  const campaign = (await campaignsOf(c)).find((x) => x.platform === platform && x.campaignId === campaignId);
  if (!campaign) throw new CampaignPortalError("That campaign is not one of this client's campaigns.");
  const { error } = await osTable("os_campaign_portals").upsert({
    platform, campaign_id: campaignId, campaign_name: campaign.name, os_client_id: osClientId,
    mi_client_id: portalId, source: "manual", decided_at: new Date().toISOString(), decided_by: by,
  }, { onConflict: "platform,campaign_id" });
  if (error) throw new CampaignPortalError(/os_campaign_portals|schema cache|does not exist/i.test(error.message) ? MIGRATION : error.message);
}
