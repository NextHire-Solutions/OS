import "server-only";

import { osTable } from "@/lib/clients/os-db";

import type { LinkStore, PortalRoute, ProspectsPick, RouteSource } from "./links.ts";

/*
 * The OS database side of renew/links.ts: os_campaign_portals (0025),
 * os_campaign_list_clients (0042 + prospects_by_mls, 0046) and
 * os_setup_campaigns (0046), all in the Master Inbox Supabase project. Every
 * change is conditional on the row still naming the old campaign, so a person's
 * change made meanwhile is never overwritten.
 */

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export const linkStore: LinkStore = {
  async route(campaignId) {
    const { data, error } = await osTable("os_campaign_portals")
      .select("os_client_id, mi_client_id, source")
      .eq("platform", "emailbison")
      .eq("campaign_id", campaignId)
      .maybeSingle();
    if (error) throw new Error(`os_campaign_portals: ${error.message}`);
    const r = data as { os_client_id?: unknown; mi_client_id?: unknown; source?: unknown } | null;
    if (!r || !s(r.os_client_id) || !s(r.mi_client_id)) return null;
    return { osClientId: s(r.os_client_id), miClientId: s(r.mi_client_id), source: (s(r.source) === "manual" ? "manual" : "auto") as RouteSource };
  },

  async saveRoute(campaignId: string, campaignName: string, route: PortalRoute, by: string) {
    // Upsert: the 10-minute auto pass may already have guessed a row for the new campaign; the old campaign's choice wins.
    const { error } = await osTable("os_campaign_portals").upsert(
      {
        platform: "emailbison",
        campaign_id: campaignId,
        campaign_name: campaignName,
        os_client_id: route.osClientId,
        mi_client_id: route.miClientId,
        source: route.source,
        decided_at: new Date().toISOString(),
        decided_by: by,
      },
      { onConflict: "platform,campaign_id" },
    );
    if (error) throw new Error(`os_campaign_portals: ${error.message}`);
  },

  async picks() {
    const { data, error } = await osTable("os_campaign_list_clients").select("os_client_id, prospects_campaign_id, prospects_by_mls");
    if (error) throw new Error(`os_campaign_list_clients: ${error.message}`);
    return ((data ?? []) as Array<{ os_client_id: unknown; prospects_campaign_id: unknown; prospects_by_mls: unknown }>).map((r) => ({
      osClientId: s(r.os_client_id),
      single: s(r.prospects_campaign_id) || null,
      byMls: r.prospects_by_mls && typeof r.prospects_by_mls === "object" && !Array.isArray(r.prospects_by_mls)
        ? (r.prospects_by_mls as Record<string, { id: string; name?: string }>)
        : {},
    }));
  },

  async setPick(osClientId, mlsCode, fromId, toId, campaignName, by) {
    const now = new Date().toISOString();
    if (!mlsCode) {
      const { data, error } = await osTable("os_campaign_list_clients")
        .update({ prospects_campaign_id: toId, prospects_campaign_name: campaignName, updated_at: now, updated_by: by })
        .eq("os_client_id", osClientId)
        .eq("prospects_campaign_id", fromId)
        .select("os_client_id");
      if (error) throw new Error(`os_campaign_list_clients: ${error.message}`);
      return ((data ?? []) as unknown[]).length > 0;
    }
    // One MLS's entry in the map: read, change that entry only if it still names the old campaign, write back.
    const { data: row, error: readError } = await osTable("os_campaign_list_clients")
      .select("prospects_by_mls, updated_at")
      .eq("os_client_id", osClientId)
      .maybeSingle();
    if (readError) throw new Error(`os_campaign_list_clients: ${readError.message}`);
    const map = { ...((row as { prospects_by_mls?: Record<string, { id: string; name?: string }> } | null)?.prospects_by_mls ?? {}) };
    if (s(map[mlsCode]?.id) !== fromId) return false;
    map[mlsCode] = { id: toId, name: campaignName };
    const stamp = s((row as { updated_at?: unknown } | null)?.updated_at);
    let q = osTable("os_campaign_list_clients")
      .update({ prospects_by_mls: map, updated_at: now, updated_by: by })
      .eq("os_client_id", osClientId);
    // Written only if nobody saved the row since it was read.
    if (stamp) q = q.eq("updated_at", stamp);
    const { data, error } = await q.select("os_client_id");
    if (error) throw new Error(`os_campaign_list_clients: ${error.message}`);
    return ((data ?? []) as unknown[]).length > 0;
  },

  async setups(campaignId) {
    const { data, error } = await osTable("os_setup_campaigns").select("os_client_id, mls_code").eq("campaign_id", campaignId);
    if (error) throw new Error(`os_setup_campaigns: ${error.message}`);
    return ((data ?? []) as Array<{ os_client_id: unknown; mls_code: unknown }>).map((r): ProspectsPick => ({ osClientId: s(r.os_client_id), mlsCode: s(r.mls_code) }));
  },

  async setSetup(osClientId, mlsCode, fromId, toId, campaignName) {
    const { data, error } = await osTable("os_setup_campaigns")
      .update({ campaign_id: toId, campaign_name: campaignName, updated_at: new Date().toISOString() })
      .eq("os_client_id", osClientId)
      .eq("mls_code", mlsCode)
      .eq("campaign_id", fromId)
      .select("os_client_id");
    if (error) throw new Error(`os_setup_campaigns: ${error.message}`);
    return ((data ?? []) as unknown[]).length > 0;
  },
};
