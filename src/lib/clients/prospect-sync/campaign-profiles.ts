import "server-only";

import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";

import { mlsCodesOf, normCity, PROFILE_SAMPLE, type CampaignProfile } from "./auto-link";

/*
 * Where a campaign's leads come from (auto-link.ts): a recent sample of its leads (Analytics campaign_leads, still in the
 * campaign) and the MLS and cities each was made with (lead_attributes "mls affiliation", "office city", "top producing
 * city" — the custom fields every lead carries, lead-map.ts). The OS keeps both tables current (sync-campaign-leads), so
 * a renewed campaign is known within the hour. Reads only. Kept a few hours per campaign: where an area's agents are
 * doesn't move by the minute.
 *
 * A campaign whose leads can't be read comes back with sampled 0: it is never linked automatically (never a guess).
 */

const TTL_MS = 3 * 60 * 60_000;
const cache: Map<string, { at: number; profile: Omit<CampaignProfile, "name" | "status"> }> =
  ((globalThis as Record<symbol, unknown>)[Symbol.for("os.prospects.campaignProfiles")] ??= new Map()) as Map<string, { at: number; profile: Omit<CampaignProfile, "name" | "status"> }>;

const ATTRS = ["mls affiliation", "office city", "top producing city"];

async function readOne(id: string): Promise<Omit<CampaignProfile, "name" | "status">> {
  const sb = getAnalyticsSupabase();
  const team = analyticsTeamId();
  const { data: leads, error } = await sb.from("campaign_leads").select("lead_id").eq("team_id", team).eq("campaign_id", Number(id)).is("removed_at", null).order("lead_id", { ascending: false }).limit(PROFILE_SAMPLE);
  if (error) throw new Error(`campaign_leads: ${error.message}`);
  const ids = ((leads ?? []) as Array<{ lead_id: number }>).map((r) => r.lead_id);
  const mls: Record<string, number> = {};
  const cities: Record<string, number> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error: e2 } = await sb.from("lead_attributes").select("lead_id, name, value").eq("team_id", team).in("lead_id", ids.slice(i, i + 100)).in("name", ATTRS);
    if (e2) throw new Error(`lead_attributes: ${e2.message}`);
    const perLead = new Map<number, Set<string>>();
    for (const a of (data ?? []) as Array<{ lead_id: number; name: string; value: string | null }>) {
      if (a.name === "mls affiliation") for (const c of mlsCodesOf(a.value)) mls[c] = (mls[c] ?? 0) + 1;
      else {
        const c = normCity(a.value);
        if (!c) continue;
        // A lead's office city and top producing city count once together when they're the same place.
        const seen = perLead.get(a.lead_id) ?? new Set<string>();
        if (!seen.has(c)) cities[c] = (cities[c] ?? 0) + 1;
        seen.add(c);
        perLead.set(a.lead_id, seen);
      }
    }
  }
  return { id, sampled: ids.length, mls, cities };
}

/** Each campaign's profile (name and status from the caller's list). Never throws: an unreadable one has sampled 0. */
export async function campaignProfiles(campaigns: ReadonlyArray<{ id: string; name: string; status: string }>, now = Date.now()): Promise<CampaignProfile[]> {
  const out: CampaignProfile[] = [];
  for (const c of campaigns) {
    const had = cache.get(c.id);
    let profile = had && now - had.at < TTL_MS ? had.profile : null;
    if (!profile) {
      try {
        profile = await readOne(c.id);
        cache.set(c.id, { at: now, profile });
      } catch (e) {
        console.error(JSON.stringify({ at: "[prospect-sync] campaign profile unreadable — not linked automatically", campaignId: c.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
        profile = { id: c.id, sampled: 0, mls: {}, cities: {} };
      }
    }
    out.push({ ...profile, name: c.name, status: c.status });
  }
  return out;
}

/** Tests only. */
export function _forgetProfiles(): void { cache.clear(); }
