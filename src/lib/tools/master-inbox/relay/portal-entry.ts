import type { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

/*
 * A hand-off's agent in the client's Pipeline (4 Nov, Eddy: these leads are "going to land straight onto the client's inbox
 * and … populate on their new portal under their pipeline view"). For a client on the new model only
 * (os_clients.pipeline_entry = 'interested'), once the hand-off has really gone.
 *
 * It is the row the Introduction label's trigger makes (Master Inbox migrations 0023, 0072, 0073: client_pipeline_on_intro_label),
 * WITHOUT the label: that label wipes "Interested" off the conversation and announces an introduction to the client (Slack,
 * the notifier), and the email has just told them. The first stage is the same enum value; what a portal CALLS it is that
 * portal's (Interested, on the new model).
 *
 * One addition to the trigger's fields: EmailBison's leads keep their number under "phone number" and their brokerage on the
 * lead itself, neither of which the trigger reads, and the Pipeline shows a phone only from the entry's own column (of the
 * last 40 real entries, 38 had a number on the lead and none showed it). So these look as far as the Interested Slack alert
 * does (interested-alerts.ts), and the client sees what our team saw. Anything the trigger finds still wins, in its order.
 *
 * Once per conversation, by the table's own unique (client_id, thread_id): a second try finds the first and adds nothing.
 */

type Mi = ReturnType<typeof getMasterInboxSupabase>;
type CustomFields = Record<string, unknown> | null | undefined;

/** Postgres's `->>`: text, or null when the key is missing. An empty string stays one, exactly as coalesce treats it. */
function text(fields: CustomFields, key: string): string | null {
  const v = fields?.[key];
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

export interface EntryLead {
  full_name?: string | null;
  email?: string | null;
  company?: string | null;
  custom_fields?: CustomFields;
}

/** The trigger's values, in its order of preference, then the alert's. The hand-off's own name and address only when there's no lead to read. */
export function pipelineEntryRow(o: { portalId: string; threadId: string; leadId: string | null; lead: EntryLead | null; agentName: string | null; agentEmail: string | null; at: string }) {
  const f = o.lead?.custom_fields;
  return {
    client_id: o.portalId,
    thread_id: o.threadId,
    lead_id: o.leadId,
    stage: "introduction",
    lead_name: o.lead?.full_name ?? o.agentName,
    lead_email: text(f, "preferred_email") ?? o.lead?.email ?? o.agentEmail,
    lead_phone: text(f, "preferred_phone") ?? text(f, "phone") ?? text(f, "Phone") ?? text(f, "phone number") ?? text(f, "phone_number") ?? text(f, "mobile"),
    current_brokerage: text(f, "companyName") ?? text(f, "company") ?? o.lead?.company ?? null,
    agent_profile_url: text(f, "Agent Profile") ?? text(f, "agentProfile") ?? text(f, "website"),
    introduced_at: o.at,
  };
}

/** Puts the agent in the portal's Pipeline. The new entry's id; null when this conversation already has one. Throws on a failed read or write. */
export async function enterPipeline(mi: Mi, o: { portalId: string; threadId: string; agentName: string | null; agentEmail: string | null; at: string }): Promise<string | null> {
  const { data: thread, error: tErr } = await mi.from("threads").select("lead_id").eq("id", o.threadId).maybeSingle();
  if (tErr) throw new Error(`threads: ${tErr.message}`);
  const leadId = ((thread as { lead_id?: string | null } | null)?.lead_id ?? null) as string | null;
  let lead: EntryLead | null = null;
  if (leadId) {
    const { data, error } = await mi.from("leads").select("full_name, email, company, custom_fields").eq("id", leadId).maybeSingle();
    if (error) throw new Error(`leads: ${error.message}`);
    lead = (data as EntryLead | null) ?? null;
  }
  const row = pipelineEntryRow({ ...o, leadId, lead });
  const { data, error } = await mi.from("client_pipeline_entries").upsert(row, { onConflict: "client_id,thread_id", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(`client_pipeline_entries: ${error.message}`);
  const made = (data ?? []) as Array<{ id: string }>;
  return made[0]?.id ?? null;
}
