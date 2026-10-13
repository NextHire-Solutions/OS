import "server-only";

import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import { analyticsTeamId, getAnalyticsSupabase } from "./supabase";
import { campaignIdsWithTags, narrowByTags, tagOptions, type TagOption, type TaggedCampaign } from "./tag-filter-rule.ts";

/*
 * The Tag filter's one database read (see tag-filter-rule.ts for the rules).
 *
 * Every analytics endpoint resolves its filters and then passes them through
 * `narrowToTags`, so a tag is honoured everywhere a campaign selection is — and
 * costs nothing when no tag is chosen (no read at all).
 *
 * The list of campaigns and their tags is a couple of hundred small rows that
 * change on the half-hourly sync, and one filter click fans out to half a dozen
 * endpoints at once, so it is read once a minute for the whole process.
 */
const taggedCampaigns = ttlCache(
  async (): Promise<TaggedCampaign[]> => {
    const { data, error } = await getAnalyticsSupabase()
      .from("campaigns")
      .select("id, tags")
      .eq("team_id", analyticsTeamId())
      // A deleted campaign's tag must not keep the tag in the picker.
      .is("deleted_at", null);
    if (error) throw new Error(`Could not read campaign tags: ${error.message}`);
    return ((data ?? []) as Array<{ id: number | string; tags: unknown }>).map((r) => ({ id: Number(r.id), tags: r.tags }));
  },
  { ttlMs: 60_000, key: () => "all", shared: "analytics-tagged-campaigns" },
);

/** The filters with any tag selection folded into the campaign selection. */
export async function narrowToTags<F extends Parameters<typeof narrowByTags>[0]>(filters: F): Promise<F> {
  if (!filters.tags.length) return filters;
  return narrowByTags(filters, campaignIdsWithTags(await taggedCampaigns(), filters.tags));
}

/** Every tag in use, for the picker. Empty rather than an error: a picker with nothing in it still opens. */
export async function analyticsTagOptions(): Promise<TagOption[]> {
  try {
    return tagOptions(await taggedCampaigns());
  } catch (e) {
    console.error("[analytics] tag options:", e instanceof Error ? e.message : e);
    return [];
  }
}
