import { getMasterInboxSupabase as createAdminSupabase } from "../supabase";
import { createEmailBisonClient } from "../emailbison/client";

// Resolves and caches a thread's EmailBison reply_followup campaign
// membership onto the thread row (migration 0029). Parallel to
// lib/inbox/subsequence-sync.ts on the Instantly side. The prospect
// panel reads the cached columns — fast — and this keeps them fresh.
//
// status semantics:
//   active  — the lead has UPCOMING scheduled-emails rows in a campaign
//             with type='reply_followup'. They're currently being
//             sequenced; the picker should be disabled.
//   past    — the lead has sent-emails in a reply_followup campaign but
//             no scheduled rows remain (sequence completed, or they
//             unsubscribed / replied out of the queue). The picker
//             stays enabled.
//   none    — never enrolled in any reply_followup campaign.

export type FollowupStatus = "active" | "past" | "none";

export interface FollowupCampaignState {
  status: FollowupStatus;
  campaignId: number | null;
  campaignName: string | null;
  nextScheduledAt: string | null;
}

const EMPTY: FollowupCampaignState = {
  status: "none",
  campaignId: null,
  campaignName: null,
  nextScheduledAt: null,
};

// team_id → reply_followup campaign id set + name map, 10-minute TTL.
// A team's reply_followup catalog is small (tens) and rarely changes;
// reusing this across threads in the same team saves a full
// listAllCampaigns walk per panel open.
interface FollowupCacheEntry {
  at: number;
  ids: Set<number>;
  names: Map<number, string>;
}
const followupCampaignsCache = new Map<number, FollowupCacheEntry>();
const FOLLOWUP_TTL_MS = 10 * 60 * 1000;

async function resolveFollowupCampaigns(
  client: ReturnType<typeof createEmailBisonClient>,
  teamId: number,
): Promise<FollowupCacheEntry> {
  const cached = followupCampaignsCache.get(teamId);
  if (cached && Date.now() - cached.at < FOLLOWUP_TTL_MS) return cached;
  await client.switchWorkspace(teamId);
  const all = await client.listAllCampaigns();
  const ids = new Set<number>();
  const names = new Map<number, string>();
  for (const c of all) {
    if (c.type === "reply_followup") {
      ids.add(c.id);
      names.set(c.id, c.name);
    }
  }
  const entry: FollowupCacheEntry = { at: Date.now(), ids, names };
  followupCampaignsCache.set(teamId, entry);
  return entry;
}

// Look up the thread's lead in EmailBison, intersect their scheduled +
// sent emails against the team's reply_followup campaigns, persist
// the result on the thread, and return the state. Safe to call before
// migration 0029 — the column write just no-ops then.
export async function syncThreadFollowup(threadId: string): Promise<FollowupCampaignState> {
  const admin = createAdminSupabase();
  const { data: thread } = await admin
    .from("threads")
    .select("id, source_provider, channel_id, lead_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread || thread.source_provider !== "emailbison" || !thread.lead_id) {
    return EMPTY;
  }

  const { data: lead } = await admin
    .from("leads")
    .select("emailbison_lead_id")
    .eq("id", thread.lead_id)
    .maybeSingle();
  const ebLeadId = (lead?.emailbison_lead_id as string | null) ?? null;
  if (!ebLeadId) return EMPTY;

  // Resolve the EmailBison team via the thread's channel. We can't
  // default to the API key's home team because brokerstaffer.com runs
  // multiple teams under one workspace.
  let ebTeamId: number | null = null;
  if (thread.channel_id) {
    const { data: ch } = await admin
      .from("channels")
      .select("emailbison_team_id")
      .eq("id", thread.channel_id)
      .maybeSingle();
    ebTeamId = (ch?.emailbison_team_id as number | null) ?? null;
  }
  if (ebTeamId === null) return EMPTY;

  let state: FollowupCampaignState;
  try {
    const client = createEmailBisonClient();
    const { ids: followupIds, names: followupNames } = await resolveFollowupCampaigns(
      client,
      ebTeamId,
    );

    // resolveFollowupCampaigns left the client switched into ebTeamId.
    // Active first — scheduled-emails is the source of truth for
    // "currently being sequenced".
    let activeCampaignId: number | null = null;
    let nextScheduled: string | null = null;
    try {
      const scheduled = await client.getLeadScheduledEmails(ebLeadId);
      for (const row of scheduled.data ?? []) {
        if (!followupIds.has(row.campaign_id)) continue;
        activeCampaignId = row.campaign_id;
        const scheduledAt = row.scheduled_date ?? null;
        if (scheduledAt && (!nextScheduled || scheduledAt < nextScheduled)) {
          nextScheduled = scheduledAt;
        }
      }
    } catch (err) {
      console.error("[followup-sync] scheduled-emails fetch failed", err);
    }

    if (activeCampaignId !== null) {
      state = {
        status: "active",
        campaignId: activeCampaignId,
        campaignName: followupNames.get(activeCampaignId) ?? null,
        nextScheduledAt: nextScheduled,
      };
    } else {
      // Only check sent-emails when no active enrollment was found —
      // the past-membership signal is purely informational.
      let pastCampaignId: number | null = null;
      try {
        const sent = await client.getLeadSentEmails(ebLeadId);
        for (const row of sent.data ?? []) {
          if (followupIds.has(row.campaign_id)) {
            pastCampaignId = row.campaign_id;
            break;
          }
        }
      } catch (err) {
        console.error("[followup-sync] sent-emails fetch failed", err);
      }
      state =
        pastCampaignId !== null
          ? {
              status: "past",
              campaignId: pastCampaignId,
              campaignName: followupNames.get(pastCampaignId) ?? null,
              nextScheduledAt: null,
            }
          : EMPTY;
    }
  } catch (err) {
    console.error("[followup-sync] failed", err);
    return EMPTY;
  }

  // Persist. .update() returns an error rather than throwing if the
  // columns don't exist yet — harmless before 0029 lands.
  await admin
    .from("threads")
    .update({
      followup_campaign_id: state.campaignId,
      followup_campaign_name: state.campaignName,
      followup_status: state.status === "none" ? null : state.status,
      followup_next_scheduled: state.nextScheduledAt,
      followup_synced_at: new Date().toISOString(),
    })
    .eq("id", threadId);

  return state;
}
