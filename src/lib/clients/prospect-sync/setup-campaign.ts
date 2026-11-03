import { osTable } from "@/lib/clients/os-db";
import { clientFieldsProblem, clientFieldValues } from "@/lib/tools/analytics/campaigns/client-fields";
import { fillCampaignSequence } from "@/lib/tools/analytics/campaigns/client-fields-load";
import { createEmailBisonClient, type EmailBisonClient } from "@/lib/tools/analytics/emailbison/client";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";

import { setupCampaignName } from "./rules.ts";

/*
 * A new client's first campaign (2 Nov — Eddy: "Create campaign when they setup portal"; the user: a DRAFT copy of a
 * template the team picks). Made once per client, by the background run, for a client that finished setup and has no
 * campaign of its own: EmailBison's duplicate of the template (its emails, settings and schedule), renamed
 * "<Client> + <Market> + Prospects (<TZ>)", its client fields ({CLIENT_AREA}, {CLIENT_ALIAS}) filled, the template's
 * sending inboxes attached — and never started: the team writes the emails from the client's offer, the client
 * approves them, a person launches it (the Launch tab refuses while a client field is unfilled). Linked to the client
 * in Analytics as a fan-out's copy is, when the client has an Analytics record.
 *
 * A client with several MLSs (a campaign per market — the user, 3 Nov) gets one per MLS, "<Client> + <MLS> + Prospects
 * (<TZ>)", each claimed on its own: its {CLIENT_AREA} is left for the team (which area an MLS covers is not recorded),
 * and the bell says so; nothing is set as the client's Prospects campaign — the run uses it for that MLS until the team
 * picks one on the Campaigns tab.
 *
 * No template chosen (4 Nov, the user: "can't we just create campaign with leads in it?"): a BLANK draft under the same
 * name, so a client's prospects never wait on a template. Its emails, schedule and inboxes are the team's to add — the
 * bell says so — and it is never started either.
 *
 * Never touches the onboarding orchestrator's fields (bison_campaign_id, leads_inreview, bison_leads_exported):
 * those arm its auto-launch and its "your campaign is live" email to the client.
 */

export interface Template { campaignId: string; campaignName: string | null; updatedBy: string | null; updatedAt: string | null }

/** The setup template, or null when none is set (a new client's first campaign is then a blank draft). */
export async function loadTemplate(): Promise<Template | null> {
  const { data, error } = await osTable("os_prospect_sync_settings").select("template_campaign_id, template_campaign_name, updated_by, updated_at").eq("id", "default").maybeSingle();
  if (error) throw new Error(`os_prospect_sync_settings: ${error.message}`);
  const r = data as { template_campaign_id: string | null; template_campaign_name: string | null; updated_by: string | null; updated_at: string | null } | null;
  return r?.template_campaign_id ? { campaignId: r.template_campaign_id, campaignName: r.template_campaign_name, updatedBy: r.updated_by, updatedAt: r.updated_at } : null;
}

/** A person picks the template: an EmailBison campaign that exists (read back from EmailBison first). */
export async function saveTemplate(campaignId: number, who: string, eb: Pick<EmailBisonClient, "getCampaign"> = createEmailBisonClient()): Promise<Template> {
  const c = await eb.getCampaign(campaignId);
  const name = typeof c?.name === "string" ? c.name : null;
  if (!c || Number(c.id) !== campaignId) throw new Error("EmailBison has no such campaign.");
  const row = { id: "default", template_campaign_id: String(campaignId), template_campaign_name: name, updated_by: who, updated_at: new Date().toISOString() };
  const { error } = await osTable("os_prospect_sync_settings").upsert(row, { onConflict: "id" });
  if (error) throw new Error(`os_prospect_sync_settings: ${error.message}`);
  return { campaignId: row.template_campaign_id, campaignName: name, updatedBy: who, updatedAt: row.updated_at };
}

export interface SetupClient {
  osClientId: string;
  portalId: string;
  name: string;
  aliases: readonly string[];
  areas: readonly string[];
  mls: readonly string[];
  timeZone: string | null;
  /** The client's Analytics record, when it has one. */
  analyticsClientId: string | null;
  /** A client with several MLSs: the MLS this campaign is for (the agent database's code). */
  mlsCode?: string | null;
}

export type SetupOutcome =
  | { kind: "ready"; campaignId: string; campaignName: string; created: boolean; note: string | null; blank?: true }
  | { kind: "waiting"; reason: string }
  | { kind: "failed"; reason: string };

type Eb = {
  duplicateCampaign: (id: number, opts?: { retry?: boolean }) => Promise<{ data?: { id?: unknown } } | undefined>;
  createCampaign: (name: string, opts?: { retry?: boolean }) => Promise<{ data?: { id?: unknown } } | undefined>;
} & Pick<EmailBisonClient, "updateCampaign" | "getCampaignSenderEmails" | "attachSenderEmails" | "getCampaignSequenceSteps"> & Partial<EmailBisonClient>;

/** Said to our team about a campaign made with no template. */
const BLANK_NOTE = "Created blank (no template is set): add its emails, schedule and sending inboxes before launching it.";

/** A claim older than this (a run that died mid-way) is reported, never retried: a retry could make a second campaign. */
const STALE_CLAIM_MS = 15 * 60_000;

/**
 * The client's setup campaign: the one made already, or made now. At most one per client — the os_setup_campaigns
 * row is inserted before EmailBison is asked (its primary key is the claim), and the new campaign's id is written to
 * it the moment it exists, so a failure part-way leaves a campaign a person can find, never a second one.
 */
export async function ensureSetupCampaign(client: SetupClient, o: { by: string; test: boolean; now?: Date; eb?: Eb }): Promise<SetupOutcome> {
  const now = o.now ?? new Date();
  const market = (client.mlsCode ?? "").trim();
  const what = market ? `Its first campaign for ${market}` : "Its first campaign";
  const existing = await osTable("os_setup_campaigns").select("status, campaign_id, campaign_name, error, created_at").eq("os_client_id", client.osClientId).eq("mls_code", market).maybeSingle();
  if (existing.error) throw new Error(`os_setup_campaigns: ${existing.error.message}`);
  const had = existing.data as { status: string; campaign_id: string | null; campaign_name: string | null; error: string | null; created_at: string } | null;
  if (had?.status === "ready" && had.campaign_id) return { kind: "ready", campaignId: had.campaign_id, campaignName: had.campaign_name ?? had.campaign_id, created: false, note: null };
  if (had?.status === "failed") return { kind: "failed", reason: had.error ?? `${what} could not be made.` };
  if (had?.status === "creating") {
    return now.getTime() - Date.parse(had.created_at) > STALE_CLAIM_MS
      ? { kind: "failed", reason: `Making ${what.charAt(0).toLowerCase()}${what.slice(1)} stopped part-way${had.campaign_id ? ` (EmailBison campaign ${had.campaign_id})` : ""} — check it in EmailBison.` }
      : { kind: "waiting", reason: `${what} is being made.` };
  }

  // A read that fails stops here (it throws): "no template" only ever means none is set.
  const template = await loadTemplate();

  const name = market
    ? setupCampaignName(client.name, { mls: [market] }, client.timeZone)
    : setupCampaignName(client.name, { areas: client.areas, mls: client.mls }, client.timeZone);
  const claim = await osTable("os_setup_campaigns").insert({
    os_client_id: client.osClientId, mls_code: market, portal_id: client.portalId, status: "creating", template_campaign_id: template?.campaignId ?? "",
    campaign_name: name, created_by: o.by, test: o.test, created_at: now.toISOString(), updated_at: now.toISOString(),
  });
  if (claim.error) {
    if (/duplicate|unique/i.test(claim.error.message)) return { kind: "waiting", reason: `${what} is being made.` };
    throw new Error(`os_setup_campaigns: ${claim.error.message}`);
  }
  const mark = (patch: Record<string, unknown>) => osTable("os_setup_campaigns").update({ ...patch, updated_at: new Date().toISOString() }).eq("os_client_id", client.osClientId).eq("mls_code", market);

  const eb = o.eb ?? createEmailBisonClient();
  let created: number | null = null;
  let asked = false;
  try {
    // Sent ONCE (never retried): an answer lost after EmailBison made it would otherwise make a second.
    asked = true;
    const made = template ? await eb.duplicateCampaign(Number(template.campaignId), { retry: false }) : await eb.createCampaign(name, { retry: false });
    created = Number(made?.data?.id);
    if (!Number.isInteger(created) || created <= 0) throw new Error("EmailBison did not return the new campaign's id");
    // Written down at once: whatever happens next, this campaign is known and is this client's.
    await mark({ campaign_id: String(created) });

    let note: string | null = template ? null : BLANK_NOTE;
    if (template) {
      await eb.updateCampaign(created, { name });

      // The client's fields, from its own record (a client with no Analytics record has them too) — one MLS's campaign
      // leaves its area to the team.
      const values = clientFieldValues({ name: client.name, aliases: client.aliases, areas: market ? [] : client.areas });
      try {
        const filled = await fillCampaignSequence(eb as EmailBisonClient, created, name, values);
        const problem = clientFieldsProblem(filled.missing, values);
        if (problem) note = `Client fields not filled: ${problem.replace(", so the sequence cannot be saved with it", "")}`;
      } catch (error) {
        note = `Could not check the sequence for client fields: ${describeEmailBisonError(error)}. Open its sequence before starting it.`;
      }

      const senders = (await eb.getCampaignSenderEmails(Number(template.campaignId))).map((s) => s.id).filter(Boolean);
      for (let i = 0; i < senders.length; i += 250) await eb.attachSenderEmails(created, senders.slice(i, i + 250));
    }

    if (client.analyticsClientId) await linkInAnalytics(created, name, client.analyticsClientId, template ? Number(template.campaignId) : null, o.by);
    // It becomes the client's Prospects campaign (shown, and changeable, on the client's Campaigns tab) — unless the team
    // chose one already: that choice is never overwritten. One MLS's campaign: shown there for its MLS, nothing written.
    const had = market ? null : await osTable("os_campaign_list_clients").select("prospects_campaign_id").eq("os_client_id", client.osClientId).maybeSingle();
    const chosen = (had?.data as { prospects_campaign_id?: string | null } | null)?.prospects_campaign_id ?? null;
    if (had && !had.error && !chosen) {
      const pick = had.data
        ? await osTable("os_campaign_list_clients").update({ prospects_campaign_id: String(created), prospects_campaign_name: name, updated_at: new Date().toISOString(), updated_by: o.by }).eq("os_client_id", client.osClientId).is("prospects_campaign_id", null)
        : await osTable("os_campaign_list_clients").insert({ os_client_id: client.osClientId, prospects_campaign_id: String(created), prospects_campaign_name: name, updated_at: new Date().toISOString(), updated_by: o.by });
      if (pick.error) note = [note, `Not set as its Prospects campaign: ${pick.error.message}`].filter(Boolean).join(" ");
    }

    await mark({ status: "ready", campaign_name: name, error: note });
    return { kind: "ready", campaignId: String(created), campaignName: name, created: true, note, ...(template ? {} : { blank: true as const }) };
  } catch (error) {
    const reason = created
      ? `${what} could not be finished (EmailBison campaign ${created} was made — check it there): ${describeEmailBisonError(error)}`
      : asked
        ? template
          ? `EmailBison didn't answer when asked to copy the template (${describeEmailBisonError(error)}) — it may still have made the copy. Look in EmailBison for "Copy of ${template.campaignName ?? template.campaignId}" before making this client's first campaign by hand.`
          : `EmailBison didn't answer when asked to create the campaign (${describeEmailBisonError(error)}) — it may still have made it. Look in EmailBison for "${name}" before making this client's first campaign by hand.`
        : `${what} could not be made: ${describeEmailBisonError(error)}`;
    await mark({ status: "failed", error: reason.slice(0, 1000) });
    return { kind: "failed", reason };
  }
}

/** As a fan-out's copy: cached as a draft, pinned to the client (`manual`), audited — mapping checked, not assumed. */
async function linkInAnalytics(campaignId: number, name: string, analyticsClientId: string, templateId: number | null, by: string): Promise<void> {
  const sb = getAnalyticsSupabase();
  const teamId = analyticsTeamId();
  const cached = await sb.from("campaigns").upsert({ id: campaignId, team_id: teamId, name, status: "draft", synced_at: new Date().toISOString() }, { onConflict: "id" });
  if (cached.error) throw new Error(`caching the new campaign: ${cached.error.message}`);
  const mapped = await sb.from("campaign_clients").upsert({
    campaign_id: campaignId, client_id: analyticsClientId, match_method: "manual", matched_on: "portal-setup", confidence: 1,
    ambiguous: false, excluded: false, exclude_reason: null, resolved_at: new Date().toISOString(),
  }, { onConflict: "campaign_id" });
  if (mapped.error) throw new Error(`linking the new campaign to the client: ${mapped.error.message}`);
  await sb.from("campaign_audit_log").insert({
    team_id: teamId, campaign_id: campaignId, campaign_name: name, action: "portal-setup", actor: by, status: "ok", error: null,
    before_state: { source_campaign_id: templateId }, after_state: { campaign_id: campaignId }, batch_id: crypto.randomUUID(),
  });
}
