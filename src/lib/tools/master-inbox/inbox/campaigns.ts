import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";
import { ttlCache } from "@/lib/cache/ttl";

export interface CampaignOption {
  id: string;          // campaign_id text (EB numeric id or Instantly uuid)
  name: string;        // human-readable name from the provider
  source: "emailbison" | "instantly" | null;
}

// Returns the distinct list of (campaign_id, campaign_name, source_provider)
// triples present on threads in this workspace, sorted by name. Drives the
// "Campaigns" picker in the FilterBuilder.
//
// This scans every thread row, which under concurrent load was firing once
// per inbox page render per user. TTL-caching for 60s keeps the picker
// fresh enough (new campaigns surface within a minute) and removes the
// scan from the hot path.
async function fetchCampaigns(workspaceId: string): Promise<CampaignOption[]> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("threads")
    .select("campaign_id, campaign_name, source_provider")
    .eq("workspace_id", workspaceId)
    .not("campaign_id", "is", null);
  if (error || !data) return [];

  const seen = new Map<string, CampaignOption>();
  for (const row of data) {
    const id = row.campaign_id as string | null;
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      name: (row.campaign_name as string | null) ?? id,
      source: (row.source_provider as CampaignOption["source"]) ?? null,
    });
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export const loadCampaigns = cache(ttlCache(fetchCampaigns, { ttlMs: 60_000 }));
