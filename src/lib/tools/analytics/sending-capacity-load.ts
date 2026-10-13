import "server-only";

import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import { analyticsTeamId, getAnalyticsSupabase } from "./supabase";
import { capacityPicture, type ActiveCampaignLimit, type CapacityPicture, type CapacityRow } from "./sending-capacity.ts";

/*
 * The three reads behind the capacity picture (sending-capacity.ts has the
 * rules): the inbox limits, and each platform's ACTIVE campaigns.
 *
 * Read for every platform and scoped afterwards, so one cached answer serves
 * the Volume tile under any Platform filter and the Campaigns list. A minute's
 * cache: inbox limits and campaign limits change on the half-hourly sync, and
 * the Campaigns list re-asks on every filter click.
 */
const facts = ttlCache(
  async (): Promise<{ rows: CapacityRow[]; active: ActiveCampaignLimit[] }> => {
    const sb = getAnalyticsSupabase();
    const teamId = analyticsTeamId();
    const [capacity, emailbison, instantly] = await Promise.all([
      sb.rpc("analytics_sending_capacity", { p_team_id: teamId, p_platforms: null }),
      sb.from("campaigns")
        .select("id, max_emails_per_day, max_new_leads_per_day")
        .eq("team_id", teamId)
        .eq("status", "active")
        .is("deleted_at", null),
      // Instantly's status 1 is active. Its limits are not synced, so each of
      // these counts as a campaign with no limit on record.
      sb.from("instantly_campaigns").select("id").eq("team_id", teamId).eq("status", 1).is("archived_at", null),
    ]);
    const failed = capacity.error ?? emailbison.error ?? instantly.error;
    if (failed) throw new Error(`Sending capacity: ${failed.message}`);

    return {
      rows: (capacity.data ?? []) as CapacityRow[],
      active: [
        ...((emailbison.data ?? []) as Array<{ max_emails_per_day: number | null; max_new_leads_per_day: number | null }>).map(
          (c): ActiveCampaignLimit => ({ platform: "emailbison", daily: c.max_emails_per_day ?? null, newLeads: c.max_new_leads_per_day ?? null }),
        ),
        ...((instantly.data ?? []) as unknown[]).map((): ActiveCampaignLimit => ({ platform: "instantly", daily: null, newLeads: null })),
      ],
    };
  },
  { ttlMs: 60_000, key: () => "all", shared: "analytics-sending-capacity" },
);

/** The capacity picture for the platforms asked for (empty = all). */
export async function loadSendingCapacity(platforms: readonly string[] = []): Promise<CapacityPicture> {
  const { rows, active } = await facts();
  return capacityPicture(rows, active, platforms);
}
