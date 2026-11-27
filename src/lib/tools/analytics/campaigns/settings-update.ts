import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { COLUMN_OF, type SettingsBefore } from "./settings-rules.ts";

export { crossFieldError, planSettings, Settings, type SettingsBefore, type SettingsPatch } from "./settings-rules.ts";

/*
 * Campaign settings (spec §9.2 Settings tab) — the route's own logic, moved here unchanged (27 Nov) so the Claude
 * connector's sending-limits action runs exactly what the Settings tab runs (campaigns/[id]/settings/route.ts).
 *
 * Same discipline as the status actions: EmailBison decides, the cache is written only after a 2xx, and the attempt is
 * recorded with what the values were before. §9.5 — the screen never claims something happened that didn't.
 *
 * `before_state` matters more here than anywhere else in the app. EmailBison keeps no history of settings, so this log
 * is the only record of what the daily send limit was before someone changed it.
 */

/** The campaign's settings as the cache holds them, or null for an unknown campaign. */
export async function readSettings(campaignId: number, teamId: number): Promise<SettingsBefore | null> {
  const { data } = await getAnalyticsSupabase()
    .from("campaigns")
    .select(
      "id, name, max_emails_per_day, max_new_leads_per_day, plain_text, open_tracking, can_unsubscribe, include_auto_replies_in_stats, sequence_prioritization",
    )
    .eq("id", campaignId)
    .eq("team_id", teamId)
    .maybeSingle();
  return (data as SettingsBefore | null) ?? null;
}

export type SettingsOutcome = { ok: true; changed: Record<string, unknown> } | { ok: false; error: string };

/** Sends the change to EmailBison; on a 2xx writes the cache; either way records the attempt with what it was before. */
export async function applySettings(campaignId: number, before: SettingsBefore, changed: Record<string, unknown>, actor: string, teamId: number): Promise<SettingsOutcome> {
  const sb = getAnalyticsSupabase();
  try {
    await createEmailBisonClient().updateCampaign(campaignId, changed);
  } catch (error) {
    const message = describeEmailBisonError(error);
    await sb.from("campaign_audit_log").insert({
      team_id: teamId,
      campaign_id: campaignId,
      campaign_name: before.name,
      action: "update",
      actor,
      status: "error",
      error: message,
      before_state: pick(before, Object.keys(changed)),
      after_state: null,
    });
    return { ok: false, error: message };
  }

  const localPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changed)) {
    const column = COLUMN_OF[key];
    if (column) localPatch[column] = value;
  }

  await Promise.all([
    sb.from("campaigns").update(localPatch).eq("id", campaignId),
    sb.from("campaign_audit_log").insert({
      team_id: teamId,
      campaign_id: campaignId,
      campaign_name: before.name,
      action: "update",
      actor,
      status: "ok",
      before_state: pick(before, Object.keys(changed)),
      after_state: changed,
    }),
  ]);
  return { ok: true, changed };
}

function pick(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, source[k]]));
}
