import "server-only";

import { grantsForRequest } from "@/lib/workspace/tool-paths";
import { osTable } from "@/lib/clients/os-db";
import { loadTemplate } from "@/lib/clients/prospect-sync/setup-campaign";
import { healthyOnly } from "@/lib/tools/analytics/campaigns/attach-health-io";
import { clientFieldValues, clientFieldsIn, clientFieldsProblem } from "@/lib/tools/analytics/campaigns/client-fields.ts";
import { fillCampaignSequence } from "@/lib/tools/analytics/campaigns/client-fields-load";
import { createEmailBisonClient, type EmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import type { ToolId } from "@/lib/bs-auth";

import type { ActionSpec } from "./core.ts";
import { resolveEbCampaign } from "./campaign-one.ts";

/*
 * A new campaign, through Claude (28 Nov; the client: "creating a campaign and using leads on the database"; the user:
 * any campaign — a client's or BrokerStaffer's own). Made the way a new client's first campaign is made
 * (prospect-sync/setup-campaign.ts): EmailBison's copy of a campaign (the team's setup template unless another is named,
 * or a blank one), renamed; for a client, its client fields ({CLIENT_AREA}, {CLIENT_ALIAS}) filled and the campaign
 * linked to the client in Campaign Analytics; the copied campaign's healthy inboxes attached (EmailBison's copy brings
 * none); cached in Campaign Analytics at once, so campaign_add_agents and the other actions find it straight away.
 * NEVER started: campaign_start does that, after the Launch tab's checks.
 */

const n = (v: number) => v.toLocaleString("en-US");
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type Args = { name: string; copy_of?: string; client?: string };
type Bind = { name: string; sourceId: number | null; sourceName: string | null; client: { osClientId: string; name: string; analyticsClientId: string | null } | null; inboxes: number[] };

interface OsClient { id: string; name: string; aliases: string[] | null; areas: string[] | null; an_client_id: string | null; status: string | null }

async function findOsClient(name: string): Promise<OsClient | { error: string }> {
  const { data, error } = await osTable("os_clients").select("id, name, aliases, areas, an_client_id, status");
  if (error) return { error: `Clients could not be read: ${error.message}` };
  const rows = (data ?? []) as OsClient[];
  const k = key(name);
  const exact = rows.filter((r) => key(r.name) === k || (r.aliases ?? []).some((a) => key(a) === k));
  if (exact.length === 1) return exact[0];
  const partial = rows.filter((r) => key(r.name).includes(k));
  if (exact.length > 1 || partial.length > 1) return { error: `"${name}" matches several clients: ${(exact.length > 1 ? exact : partial).map((r) => r.name).slice(0, 8).join(", ")}. Which one?` };
  if (partial.length === 1) return partial[0];
  return { error: `No client called "${name}".` };
}

export const campaignCreate: ActionSpec<Args, Bind> = {
  name: "campaign_create",
  title: "Create a campaign",
  description:
    "Create a NEW EmailBison campaign as a draft: a copy of the team's setup template (or of another campaign named in " +
    "copy_of, or copy_of 'blank' for an empty one) — its emails, settings and schedule — renamed, with the copied " +
    "campaign's healthy inboxes attached. Give a client to tie it to that client (linked in Campaign Analytics, its " +
    "{CLIENT_AREA} / {CLIENT_ALIAS} filled); leave it out for BrokerStaffer's own campaign. It is never started here: " +
    "fill it with campaign_add_agents, then start it with campaign_start.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The new campaign's name, e.g. 'Howe Realty Group + Phoenix + Prospects (MST)'." },
      copy_of: { type: "string", description: "A campaign to copy, by name or number; 'blank' for an empty campaign. Default: the team's setup template." },
      client: { type: "string", description: "The client it is for. Leave out for BrokerStaffer's own campaign." },
    },
    required: ["name"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  needs: (grantsForRequest("/api/tools/analytics/campaigns/1/launch", "POST") ?? []) as ToolId[],
  parse(a) {
    const name = String(a.name ?? "").trim().replace(/\s+/g, " ");
    if (!name) return { error: "What should the new campaign be called?" };
    if (name.length > 255) return { error: "Keep the name under 255 characters." };
    const copy_of = typeof a.copy_of === "string" && a.copy_of.trim() ? a.copy_of.trim() : undefined;
    const client = typeof a.client === "string" && a.client.trim() ? a.client.trim() : undefined;
    return { name, ...(copy_of ? { copy_of } : {}), ...(client ? { client } : {}) };
  },
  async preview(a) {
    // A name already in use: refused, so two campaigns never answer to one name.
    const taken = await getAnalyticsSupabase().from("campaigns_unified").select("id, name, status").eq("team_id", analyticsTeamId()).ilike("name", a.name.replace(/[%_\\]/g, (ch) => `\\${ch}`)).limit(1);
    if (taken.error) return { ok: false, refusal: `Campaigns could not be read: ${taken.error.message}` };
    const t = ((taken.data ?? []) as Array<{ id: string; name: string; status: string }>)[0];
    if (t) return { ok: false, refusal: `A campaign called "${t.name}" already exists (#${t.id}, ${t.status}). Pick another name, or add agents to that one.` };

    // What it copies.
    let source: { id: number; name: string } | null = null;
    if (a.copy_of && a.copy_of.toLowerCase() !== "blank") {
      const c = await resolveEbCampaign(a.copy_of);
      if ("error" in c) return { ok: false, refusal: c.error };
      source = { id: c.id, name: c.name };
    } else if (!a.copy_of) {
      const tpl = await loadTemplate();
      if (tpl) source = { id: Number(tpl.campaignId), name: tpl.campaignName ?? `#${tpl.campaignId}` };
    }

    // For whom.
    let client: OsClient | null = null;
    if (a.client) {
      const c = await findOsClient(a.client);
      if ("error" in c) return { ok: false, refusal: c.error };
      client = c;
    }

    const eb = createEmailBisonClient();
    let what: string;
    let inboxes: number[] = [];
    const notes: string[] = [];
    if (source) {
      const steps = ((await eb.getCampaignSequenceSteps(source.id))?.data?.sequence_steps ?? []) as Array<{ email_subject?: string; email_body?: string; variant?: boolean }>;
      const senders = (await eb.getCampaignSenderEmails(source.id)).map((x) => Number(x.id)).filter((id) => Number.isInteger(id) && id > 0);
      const health = senders.length ? await healthyOnly(senders) : { ids: [] as number[], note: null as string | null };
      inboxes = [...health.ids].sort((x, y) => x - y);
      const mains = steps.filter((x) => !x.variant).length;
      what = `a copy of "${source.name}" (#${source.id}): its ${n(mains)} email${mains === 1 ? "" : "s"}${steps.length > mains ? ` (with ${n(steps.length - mains)} A/B version${steps.length - mains === 1 ? "" : "s"})` : ""}, settings and schedule; ${n(inboxes.length)} of its ${n(senders.length)} inboxes attached (healthy only)`;
      if (health.note) notes.push(health.note);
      const fields = [...new Set(steps.flatMap((x) => [...clientFieldsIn(x.email_subject), ...clientFieldsIn(x.email_body)]))];
      if (fields.length) {
        if (client) {
          const values = clientFieldValues({ name: client.name, aliases: client.aliases, areas: client.areas });
          const missing = fields.filter((f) => !values[f]);
          const problem = clientFieldsProblem(missing, values);
          notes.push(problem
            ? `${problem.replace(", so the sequence cannot be saved with it", "")} The campaign can't be started until that's filled.`
            : `Its client fields are filled for ${client.name}${fields.includes("area") ? `: {CLIENT_AREA} → "${values.area}"` : ""}${fields.includes("alias") ? `${fields.includes("area") ? "," : ":"} {CLIENT_ALIAS} → "${values.alias}"` : ""}.`);
        } else {
          notes.push("Its emails use client fields ({CLIENT_AREA} / {CLIENT_ALIAS}); with no client they stay as they are, and the campaign can't be started until they're filled or taken out.");
        }
      }
    } else {
      what = "a blank campaign (no emails, schedule or inboxes yet — add them in Campaign Analytics before starting it)";
    }
    if (client) notes.push(client.an_client_id ? `Tied to ${client.name} in Campaign Analytics.` : `${client.name} has no Campaign Analytics record, so it can't be linked there yet.`);
    else notes.push("Not tied to a client (BrokerStaffer's own).");
    return {
      ok: true,
      preview: `Create a draft campaign "${a.name}": ${what}. ${notes.join(" ")} It is not started.`,
      details: { name: a.name, copyOf: source, client: client?.name ?? null, inboxes: inboxes.length },
      bind: { name: a.name, sourceId: source?.id ?? null, sourceName: source?.name ?? null, client: client ? { osClientId: client.id, name: client.name, analyticsClientId: client.an_client_id } : null, inboxes },
    };
  },
  async execute(_a, v, bind) {
    const eb = createEmailBisonClient();
    const actor = `${v.email} via Claude`;
    let id: number | null = null;
    const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (e) {
        throw new Error(id ? `Campaign #${id} "${bind.name}" was made, but ${what} failed: ${describeEmailBisonError(e)}. Check it in Campaign Analytics.` : `The campaign wasn't made: ${describeEmailBisonError(e)}. Look in EmailBison for "${bind.sourceId ? `Copy of ${bind.sourceName}` : bind.name}" before trying again.`);
      }
    };
    const made = await step("creating it", () => (bind.sourceId ? eb.duplicateCampaign(bind.sourceId, { retry: false }) : eb.createCampaign(bind.name, { retry: false })));
    id = Number((made as { data?: { id?: unknown } })?.data?.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("EmailBison did not return the new campaign's number. Look in EmailBison before trying again.");
    // Recorded in Campaign Analytics AT ONCE, under its new name: whatever fails next, a retry finds the name taken and
    // never makes a second one (the name check reads this cache).
    const sb = getAnalyticsSupabase();
    const teamId = analyticsTeamId();
    const cached = await sb.from("campaigns").upsert({ id, team_id: teamId, name: bind.name, status: "draft", synced_at: new Date().toISOString() }, { onConflict: "id" });
    if (cached.error) throw new Error(`Campaign #${id} was made in EmailBison, but Campaign Analytics couldn't record it (${cached.error.message}). Don't make it again: find #${id} in EmailBison and rename it "${bind.name}".`);
    if (bind.sourceId) await step("renaming it", () => eb.updateCampaign(id!, { name: bind.name }));
    const notes: string[] = [];
    if (bind.sourceId && bind.client) {
      // As a new client's first campaign: a fill that can't be done is said, never a failure (the Launch tab refuses
      // to start a campaign that still holds a placeholder).
      try {
        const { data: c } = await osTable("os_clients").select("name, aliases, areas").eq("id", bind.client.osClientId).maybeSingle();
        const values = clientFieldValues(c as { name: string; aliases: string[] | null; areas: string[] | null } | null);
        const filled = await fillCampaignSequence(eb as EmailBisonClient, id!, bind.name, values);
        if (filled.missing.length) notes.push(`Client fields not filled (${filled.missing.join(", ")}): add them on ${bind.client.name}'s record and save its sequence before starting it.`);
      } catch (e) {
        notes.push(`Its client fields could not be filled (${describeEmailBisonError(e)}): open its sequence before starting it.`);
      }
    }
    for (let i = 0; i < bind.inboxes.length; i += 250) await step("attaching its inboxes", () => eb.attachSenderEmails(id!, bind.inboxes.slice(i, i + 250)));
    // Tied to the client when it has a record, and in the campaign's history.
    if (bind.client?.analyticsClientId) {
      const linked = await sb.from("campaign_clients").upsert({
        campaign_id: id, client_id: bind.client.analyticsClientId, match_method: "manual", matched_on: "claude", confidence: 1,
        ambiguous: false, excluded: false, exclude_reason: null, resolved_at: new Date().toISOString(),
      }, { onConflict: "campaign_id" });
      if (linked.error) notes.push(`Not tied to ${bind.client.name} in Campaign Analytics (${linked.error.message}): tie it on its Client tab.`);
    }
    await sb.from("campaign_audit_log").insert({
      team_id: teamId, campaign_id: id, campaign_name: bind.name, action: "create", actor, status: "ok", error: null,
      before_state: { source_campaign_id: bind.sourceId, client: bind.client?.name ?? null }, after_state: { campaign_id: id, inboxes: bind.inboxes.length }, batch_id: crypto.randomUUID(),
    });
    console.info(`[mcp-action] ${actor}: created campaign #${id} "${bind.name}"${bind.sourceId ? ` from #${bind.sourceId}` : " (blank)"}`);
    return { number: id, name: bind.name, status: "draft", copiedFrom: bind.sourceName, client: bind.client?.name ?? null, inboxes: bind.inboxes.length, ...(notes.length ? { notes } : {}), next: "Add agents with campaign_add_agents; start it with campaign_start." };
  },
};
