import "server-only";

import { masterByToolId } from "@/lib/clients/master-lookup";
import type { EmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";

import {
  NO_CLIENT, clientFieldValues, clientFieldsIn, fillSteps, usesClientFields,
  type ClientFieldKey, type ClientFieldValues,
} from "./client-fields.ts";

/*
 * Whose values fill {CLIENT_AREA} and {CLIENT_ALIAS} (client-fields.ts).
 *
 * A campaign's client is the one it is assigned to in Campaign Management
 * (`campaign_clients`, or `instantly_campaign_clients`). The values come from
 * that client's MASTER record — Area and aliases are edited on the Clients
 * page and nowhere else — reached through the link os_clients already keeps to
 * the Analytics client.
 *
 * Nothing here is called unless a sequence actually contains a client field.
 */

/** The values for an Analytics client. A client with no master record has its name and nothing else. */
export async function clientFieldValuesForClient(analyticsClientId: string): Promise<ClientFieldValues> {
  const masters = await masterByToolId("analytics");
  const master = masters.get(analyticsClientId);
  if (master) return clientFieldValues({ name: master.name, aliases: master.aliases, areas: master.markets.areas });

  const { data, error } = await getAnalyticsSupabase()
    .from("clients").select("name, aliases").eq("team_id", analyticsTeamId()).eq("id", analyticsClientId).maybeSingle();
  if (error) throw new Error(`Could not read the client: ${error.message}`);
  if (!data) return NO_CLIENT;
  return clientFieldValues({ name: String(data.name ?? ""), aliases: (data.aliases as unknown[] | null) ?? [], areas: [] });
}

/** The values for the client a campaign is assigned to. NO_CLIENT when it has none (a template). */
export async function clientFieldValuesForCampaign(
  platform: "emailbison" | "instantly",
  campaignId: string | number,
): Promise<ClientFieldValues> {
  const table = platform === "instantly" ? "instantly_campaign_clients" : "campaign_clients";
  const key = platform === "instantly" ? String(campaignId) : Number(campaignId);
  const { data, error } = await getAnalyticsSupabase()
    .from(table).select("client_id, excluded").eq("campaign_id", key).maybeSingle();
  if (error) throw new Error(`Could not read which client this campaign belongs to: ${error.message}`);
  const row = data as { client_id: string | null; excluded: boolean | null } | null;
  // An excluded campaign is deliberately kept out of client reporting: it has no client.
  if (!row?.client_id || row.excluded) return NO_CLIENT;
  return clientFieldValuesForClient(row.client_id);
}

/** EmailBison re-adds "Re: " to a threaded step on every write (see the sequence route). */
const bareSubject = (subject: string, threadReply: boolean) => (threadReply ? subject.replace(/^(?:re:\s*)+/i, "") : subject);

/*
 * Fills the client fields in a campaign's sequence AS IT STANDS in EmailBison —
 * for a campaign that was just duplicated from a template (fan-out), where the
 * copy arrives with the template's placeholders.
 *
 * Reads the steps; writes ONLY the steps that changed, and only if at least
 * one did. A sequence with no client field costs one read and no write.
 */
export async function fillCampaignSequence(
  eb: EmailBisonClient,
  campaignId: number,
  title: string,
  values: ClientFieldValues,
): Promise<{ steps: number; filled: number; missing: ClientFieldKey[] }> {
  const payload = await eb.getCampaignSequenceSteps(campaignId);
  const steps = payload?.data?.sequence_steps ?? [];
  const texts = steps.flatMap((s) => [s.email_subject, s.email_body]);
  if (!usesClientFields(texts)) return { steps: steps.length, filled: 0, missing: [] };

  const result = fillSteps(steps, values);
  const changed = result.value.filter((step, i) => step !== steps[i]);
  if (changed.length) {
    await eb.updateSequenceSteps(
      payload.data.sequence_id,
      title,
      changed.map((step) => ({
        id: step.id,
        email_subject: bareSubject(String(step.email_subject ?? ""), Boolean(step.thread_reply)),
        email_body: step.email_body,
        order: step.order,
        wait_in_days: Number(step.wait_in_days) || 0,
        variant: Boolean(step.variant),
        thread_reply: Boolean(step.thread_reply),
        ...(step.variant && step.variant_from_step_id ? { variant_from_step_id: step.variant_from_step_id } : {}),
      })),
    );
  }
  return { steps: steps.length, filled: result.filled, missing: result.missing };
}

/*
 * The client fields still sitting unfilled in a campaign's sequence — checked
 * before it is allowed to start sending.
 *
 * An unreadable sequence is "none found", deliberately: this is a guard
 * against one specific mistake (starting a template), not a gate every resume
 * has to pass, and a campaign with no sequence yet answers with an error too.
 * A placeholder is only ever blocked when it has positively been seen.
 */
export async function unfilledClientFields(eb: EmailBisonClient, campaignId: number): Promise<ClientFieldKey[]> {
  try {
    const payload = await eb.getCampaignSequenceSteps(campaignId);
    const found = new Set<ClientFieldKey>();
    for (const step of payload?.data?.sequence_steps ?? []) {
      for (const key of [...clientFieldsIn(step.email_subject), ...clientFieldsIn(step.email_body)]) found.add(key);
    }
    return [...found];
  } catch {
    return [];
  }
}
