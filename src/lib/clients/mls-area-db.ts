import "server-only";

import { mlsCatalog } from "@/lib/crm-preview/market";

import { areaForMlsCode, type Coverage } from "./coverage";
import { getMlsAreas } from "./coverage-db";
import { osTable } from "./os-db";

/*
 * WHICH AREA A CAMPAIGN'S {CLIENT_AREA} TAKES, for a client with several MLSs
 * (the client's request: "configure the area name associated with each MLS", on
 * the client's Record tab — os_clients.mls_areas, migration 0055).
 *
 * A campaign is one MLS's when the OS made it for that MLS (os_setup_campaigns,
 * mls_code) or the team picked it as that MLS's Prospects campaign
 * (os_campaign_list_clients.prospects_by_mls). Its area is the one set for that
 * MLS. A client with one MLS (or a campaign that is no single MLS's) keeps every
 * area of its record, as before.
 */

/** The MLS a campaign is for (the agent database's code, or the client's spelling), or null when it is no one MLS's. */
export async function campaignMlsCode(osClientId: string, campaignId: string | number): Promise<string | null> {
  const id = String(campaignId).trim();
  if (!id) return null;
  const setup = await osTable("os_setup_campaigns").select("mls_code").eq("os_client_id", osClientId).eq("campaign_id", id).maybeSingle();
  const made = String((setup.data as { mls_code?: unknown } | null)?.mls_code ?? "").trim();
  if (!setup.error && made) return made;
  const picks = await osTable("os_campaign_list_clients").select("prospects_by_mls").eq("os_client_id", osClientId).maybeSingle();
  if (picks.error) return null;
  const byMls = (picks.data as { prospects_by_mls?: unknown } | null)?.prospects_by_mls;
  if (!byMls || typeof byMls !== "object" || Array.isArray(byMls)) return null;
  for (const [code, pick] of Object.entries(byMls as Record<string, { id?: unknown }>)) {
    if (String(pick?.id ?? "").trim() === id && code.trim()) return code.trim();
  }
  return null;
}

/**
 * The area for this campaign's {CLIENT_AREA}:
 *   - a client with several MLSs, and a campaign that is one MLS's: the area set for that MLS — null when none is set
 *     yet (the field is then left for the team, and the save or start says so), never every area run together;
 *   - otherwise: `fallback` (every area of the record, joined — as before).
 * Unreadable lookups — and a database without migration 0055 — fall back too (they never stop a save that worked before).
 */
export async function areaForCampaign(osClientId: string, campaignId: string | number, coverage: Coverage, fallback: string | null): Promise<string | null> {
  if (coverage.mls.length < 2) return fallback;
  let code: string | null;
  try {
    code = await campaignMlsCode(osClientId, campaignId);
  } catch {
    return fallback;
  }
  if (!code) return fallback;
  const map = await getMlsAreas(osClientId).catch(() => undefined);
  // Before migration 0055 (null), or unreadable (undefined): exactly as before.
  if (!map) return fallback;
  const rows = await mlsCatalog().catch(() => []);
  return areaForMlsCode(map, code, rows);
}
