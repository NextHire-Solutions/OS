import "server-only";

import { randomUUID } from "node:crypto";

import { createEmailBisonClient, type EmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";

import { clientFieldsIn, type ClientFieldKey } from "./client-fields.ts";
import { clientFieldValuesForCampaign } from "./client-fields-load";
import { launchVerdict, type LaunchFacts, type LaunchVerdict } from "./launch.ts";

/*
 * The facts the Launch tab judges (launch.ts), read LIVE from EmailBison —
 * the cache can be half an hour old, and "has leads" must be true now, not at
 * the last sync. Four small reads: the campaign, its sequence, and the two
 * one-page counts (leads, inboxes).
 *
 * Each read fails on its own to `null`, which the verdict treats as "could not
 * be checked" and refuses on. Nothing here is a write.
 */
export async function launchFacts(
  campaignId: number,
  teamId: number,
  eb: EmailBisonClient = createEmailBisonClient(),
): Promise<{ name: string; facts: LaunchFacts } | null> {
  const sb = getAnalyticsSupabase();
  const { data: row } = await sb
    .from("campaigns")
    .select("id, name, status, max_emails_per_day, max_new_leads_per_day")
    .eq("id", campaignId).eq("team_id", teamId).is("deleted_at", null).maybeSingle();
  if (!row) return null;

  const quiet = async <T,>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      // A campaign with no sequence yet answers with an error, not an empty list.
      if (/do not exist|not found/i.test(describeEmailBisonError(error))) return undefined as unknown as T;
      return null;
    }
  };

  const [live, sequence, leads, inboxes, mapping] = await Promise.all([
    quiet(() => eb.getCampaign(campaignId)),
    quiet(() => eb.getCampaignSequenceSteps(campaignId)),
    quiet(() => eb.getCampaignLeadCount(campaignId)),
    quiet(() => eb.getCampaignSenderEmailCount(campaignId)),
    sb.from("campaign_clients").select("client_id, excluded").eq("campaign_id", campaignId).maybeSingle(),
  ]);

  // `undefined` from quiet() = "EmailBison says there is none": zero steps, a real answer.
  const steps = sequence === null ? null : (sequence?.data?.sequence_steps ?? []);
  let unfilled: ClientFieldKey[] | null = null;
  if (steps !== null) {
    const found = new Set<ClientFieldKey>();
    for (const s of steps) for (const k of [...clientFieldsIn(s.email_subject), ...clientFieldsIn(s.email_body)]) found.add(k);
    unfilled = [...found];
  }

  let clientName: string | null = null;
  try {
    clientName = (await clientFieldValuesForCampaign("emailbison", campaignId)).clientName;
  } catch {
    clientName = null; // a warning-level check; an unreadable client reads as "none"
  }

  const liveStatus = typeof (live as { status?: unknown } | null | undefined)?.status === "string"
    ? String((live as { status: string }).status).toLowerCase()
    : null;

  return {
    name: String(row.name),
    facts: {
      // EmailBison's own status when it answered; the cache's otherwise.
      status: liveStatus ?? String(row.status ?? ""),
      steps: steps === null ? null : steps.length,
      leads: leads === null ? null : Number(leads ?? 0),
      inboxes: inboxes === null ? null : Number(inboxes ?? 0),
      unfilled,
      clientName,
      excluded: Boolean((mapping.data as { excluded?: boolean } | null)?.excluded),
      dailyLimit: (row.max_emails_per_day as number | null) ?? null,
      newLeadsPerDay: (row.max_new_leads_per_day as number | null) ?? null,
    },
  };
}

export interface LaunchOutcome {
  ok: boolean;
  status?: string;
  error?: string;
  /** Present when the launch was refused by the checks — nothing was sent to EmailBison. */
  verdict?: LaunchVerdict;
}

/*
 * Starts the campaign: the checks AGAIN, server-side and live, then the one
 * call (`resume` — EmailBison's name for draft → queued as well as paused →
 * queued). The browser's copy of the checks is never trusted: between opening
 * the tab and pressing the button someone may have removed the leads.
 *
 * Audited as "launch" or "resume", and the new status is written straight into
 * the cache, exactly as the campaign actions do — otherwise the page shows
 * "draft" for up to half an hour after a launch that worked.
 */
export async function launchCampaign(
  campaignId: number,
  actor: string,
  teamId: number,
  eb: EmailBisonClient = createEmailBisonClient(),
): Promise<LaunchOutcome> {
  const read = await launchFacts(campaignId, teamId, eb);
  if (!read) return { ok: false, error: "Unknown campaign — not in the local cache. Run Sync campaigns." };
  const verdict = launchVerdict(read.facts);
  if (!verdict.can || !verdict.action) return { ok: false, error: verdict.reason ?? "This campaign cannot be started.", verdict };

  const sb = getAnalyticsSupabase();
  const audit = (status: "ok" | "error", after: Record<string, unknown> | null, error: string | null) =>
    sb.from("campaign_audit_log").insert({
      team_id: teamId,
      campaign_id: campaignId,
      platform: "emailbison",
      campaign_ref: String(campaignId),
      campaign_name: read.name,
      action: verdict.action,
      actor,
      status,
      error,
      before_state: { status: read.facts.status, steps: read.facts.steps, leads: read.facts.leads, inboxes: read.facts.inboxes },
      after_state: after,
      batch_id: randomUUID(),
    });

  try {
    const response = await eb.resumeCampaign(campaignId);
    // `queued` is what the call was observed to produce when it returns no campaign.
    const status = String(response?.data?.status ?? "queued").toLowerCase();
    await Promise.all([
      audit("ok", { status }, null),
      sb.from("campaigns").update({ status }).eq("id", campaignId),
    ]);
    return { ok: true, status };
  } catch (error) {
    const message = describeEmailBisonError(error);
    await audit("error", null, message);
    return { ok: false, error: message };
  }
}
