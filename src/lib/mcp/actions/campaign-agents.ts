import "server-only";

import { campaignClient, createAgentJob, PER_RUN, runningJobFor } from "@/lib/clients/campaign-agents/run";
import { isOpenStatus } from "@/lib/tools/analytics/campaigns/inbox-removal.ts";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { buildFilters, describeQuery } from "@/lib/tools/assistant/agent-query";
import { agentCount, resolveAgentQuery, type SearchAgentsArgs } from "@/lib/tools/assistant/tools-phase10";
import type { ToolId } from "@/lib/bs-auth";

import { canonical, type ActionSpec } from "./core.ts";
import { resolveEbCampaign } from "./campaign-one.ts";

/*
 * Agents from the agent database into a campaign, through Claude (28 Nov; the client: "creating a campaign and using
 * leads on the database"; the user: any campaign, no limit on the number of agents, the OS's own path — no enrichment).
 *
 * The person describes the agents as search_agents counts them (place, MLS, brokerage, office, sales volume,
 * transactions, emailed before or not, replied or not, a client's lists) — the same resolution, so the preview's number
 * is the number search_agents gives for those words, among agents with an email. Confirmed, one job is recorded; the
 * OS's every-minute run collects every matching agent and adds them the way a client's Prospects go in
 * (lib/clients/campaign-agents/run.ts). The person can ask for its progress (campaign_agent_jobs).
 *
 * No email or phone number is shown here: the agents go from the agent database into EmailBison, never into the chat.
 */

const n = (v: number) => v.toLocaleString("en-US");
const FILTER_KEYS = ["place", "place_type", "located_by", "mls", "brokerage", "office", "min_sales_volume", "max_sales_volume", "min_transactions", "max_transactions", "contacted", "replied", "from_client_lists"] as const;
type Args = { campaign: string } & Partial<Record<(typeof FILTER_KEYS)[number], unknown>>;
type Bind = { campaignId: number; campaignName: string; filters: string; matched: number; status: string; described: string; mlsScope: string[] | null; osClientId: string | null };

const num = (v: unknown, what: string): number | undefined | { error: string } => {
  if (v === undefined || v === null || v === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? x : { error: `${what} must be a number of 0 or more.` };
};

export const campaignAddAgents: ActionSpec<Args, Bind> = {
  name: "campaign_add_agents",
  title: "Add agents from the agent database to a campaign",
  description:
    "Add agents from the agent database (the Database app's agents) to ONE EmailBison campaign — every agent that " +
    "matches, no limit. Describe them with the same filters as search_agents (place, MLS, brokerage, office, sales " +
    "volume, transactions, emailed before or not, replied or not, a client's lists); only agents with an email go in. " +
    "The preview gives the count; confirmed, the OS adds them in the background, the way a client's Prospects go in: " +
    "the database's own email, a lead EmailBison already has added as it is, bounced or unsubscribed addresses left " +
    "out, and for a client's campaign its DNC List, My Agents and pipeline left out. Progress: campaign_agent_jobs. " +
    "Nothing is sent unless the campaign is running (start it with campaign_start).",
  inputSchema: {
    type: "object",
    properties: {
      campaign: { type: "string", description: "The campaign's name or number (campaign_create makes a new one)." },
      place: { type: "string", description: "City ('Dallas', 'Dallas, TX'), county ('Dallas County, TX'), state ('TX') or 5-digit zip." },
      place_type: { type: "string", enum: ["city", "county", "state", "zip"] },
      located_by: { type: "string", enum: ["any", "office", "home", "most_transacted"], description: "Which of the agent's locations must be in the place. Default any." },
      mls: { type: "string", description: "MLS code or name, e.g. 'NTREIS'." },
      brokerage: { type: "string", description: "Brokerage brand, e.g. 'Keller Williams'." },
      office: { type: "string", description: "One office by name." },
      min_sales_volume: { type: "number", description: "Dollars, last 12 months." },
      max_sales_volume: { type: "number", description: "Dollars, last 12 months." },
      min_transactions: { type: "number" },
      max_transactions: { type: "number" },
      contacted: { type: "boolean", description: "true = already a lead in one of our campaigns; false = never put in one." },
      replied: { type: "boolean", description: "true = has replied to us; false = never replied." },
      from_client_lists: { type: "string", description: "Only agents in this client's lists in the agent database." },
    },
    required: ["campaign"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // ADMINS ONLY: it needs BOTH the agent database (the Agent Search switch: assistant/viewer.ts search_agents) and the
  // Campaigns switch, and an action opens on any ONE of its switches (core.ts mayUse) — so it opens to nobody but admins.
  needs: [] as ToolId[],
  parse(a) {
    const campaign = String(a.campaign ?? "").trim();
    if (!campaign) return { error: "Which campaign? Give its name or number." };
    const out: Args = { campaign };
    for (const k of ["place", "place_type", "located_by", "mls", "brokerage", "office", "from_client_lists"] as const) {
      if (typeof a[k] === "string" && (a[k] as string).trim()) out[k] = (a[k] as string).trim();
    }
    for (const [k, what] of [["min_sales_volume", "min_sales_volume"], ["max_sales_volume", "max_sales_volume"], ["min_transactions", "min_transactions"], ["max_transactions", "max_transactions"]] as const) {
      const v = num(a[k], what);
      if (typeof v === "object") return v;
      if (v !== undefined) out[k] = v;
    }
    for (const k of ["contacted", "replied"] as const) if (typeof a[k] === "boolean") out[k] = a[k];
    // At least one filter: "every agent we have" is never one call away by accident. Any size is fine.
    if (!FILTER_KEYS.some((k) => out[k] !== undefined && k !== "place_type" && k !== "located_by")) {
      return { error: "Which agents? Give at least one filter — a place, an MLS, a brokerage, an office, a sales volume or transactions range, or a client's lists." };
    }
    return out;
  },
  async preview(a) {
    const c = await resolveEbCampaign(a.campaign);
    if ("error" in c) return { ok: false, refusal: c.error };
    const live = String((await createEmailBisonClient().getCampaign(c.id)).status ?? c.status).toLowerCase();
    if (!isOpenStatus(live)) return { ok: false, refusal: `${c.name} (#${c.id}) is ${live}: agents go only into a campaign that can still send.` };
    let running;
    try {
      running = await runningJobFor(String(c.id));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { ok: false, refusal: /0059/.test(why) ? "Adding agents isn't set up yet: migration 0059 (migrations/0059_campaign_agent_jobs.sql) has to be run first." : `Adding agents can't be checked just now: ${why}` };
    }
    if (running) return { ok: false, refusal: `Agents are already being added to ${c.name} (${running.status}: ${running.detail ?? "started"}). Wait for that to finish (campaign_agent_jobs), then add more.` };

    const search: SearchAgentsArgs = {
      place: a.place as string | undefined, place_type: a.place_type as SearchAgentsArgs["place_type"], located_by: a.located_by as string | undefined,
      mls: a.mls as string | undefined, brokerage: a.brokerage as string | undefined, office: a.office as string | undefined,
      min_sales_volume: a.min_sales_volume as number | undefined, max_sales_volume: a.max_sales_volume as number | undefined,
      min_transactions: a.min_transactions as number | undefined, max_transactions: a.max_transactions as number | undefined,
      contacted: a.contacted as boolean | undefined, replied: a.replied as boolean | undefined, client: a.from_client_lists as string | undefined,
      has_email: true,
    };
    const r = await resolveAgentQuery(search);
    if (!r.ok) {
      const ans = r.answer as { note?: string; didYouMean?: string[]; candidates?: string[] };
      return { ok: false, refusal: `${ans.note ?? "Those filters couldn't be resolved."}${ans.didYouMean?.length ? ` Did you mean: ${ans.didYouMean.join("; ")}?` : ""}${ans.candidates?.length ? ` Which one: ${ans.candidates.join(", ")}?` : ""}` };
    }
    const filters = buildFilters(r.q);
    const [matched, before] = await Promise.all([
      agentCount(filters),
      a.contacted === undefined ? agentCount(buildFilters({ ...r.q, contacted: true })) : Promise.resolve(null),
    ]);
    const described = describeQuery(r.q, { mls: r.resolved.mls ? [String(r.resolved.mls)] : undefined, client: r.resolved.client as string | undefined }).join("; ");
    if (!matched) return { ok: false, refusal: `No agent with an email matches: ${described}.` };
    const client = await campaignClient(c.id);
    const minutes = Math.ceil(matched / PER_RUN) + 1;
    const parts = [
      `Add ${n(matched)} agents with an email from the agent database to "${c.name}" (#${c.id}, ${live}): ${described}.`,
      before !== null && before > 0 ? `${n(before)} of them have been in one of our campaigns before.` : "",
      r.resolved.placeNote ? String(r.resolved.placeNote) : "",
      r.otherPlaces.length ? `Other places with that name: ${r.otherPlaces.slice(0, 4).join("; ")}.` : "",
      client ? `This campaign is ${client.name}'s: agents on ${client.name}'s DNC List, My Agents or pipeline are left out, and anyone already in another of ${client.name}'s campaigns isn't added twice.` : "This campaign isn't tied to a client.",
      "Each goes in the way Prospects adds agents: the database's own email; a lead EmailBison already has goes in as it is; bounced or unsubscribed addresses are left out.",
      `It runs in the background, up to ${n(PER_RUN)} agents a minute (at least ${n(minutes)} minute${minutes === 1 ? "" : "s"}; EmailBison's answers set the pace).`,
      ["active", "queued", "launching"].includes(live) ? "The campaign is sending: they start getting its emails on its schedule." : "Nothing is sent until the campaign is started.",
    ].filter(Boolean);
    return {
      ok: true,
      preview: parts.join(" "),
      details: { campaign: c.name, number: c.id, matched, filters: described, client: client?.name ?? null },
      bind: {
        campaignId: c.id, campaignName: c.name, filters: canonical(filters), matched, status: live, described,
        mlsScope: r.q.mlsIds?.length ? r.q.mlsIds.map(String) : null, osClientId: client?.osClientId ?? null,
      },
    };
  },
  async execute(_a, v, bind) {
    // Everything exactly as previewed: the bind holds it, and the fresh preview runAction just made matched it.
    const job = await createAgentJob({
      campaignId: String(bind.campaignId), campaignName: bind.campaignName, osClientId: bind.osClientId, filters: JSON.parse(bind.filters) as Record<string, unknown>,
      described: bind.described, mlsScope: bind.mlsScope, matched: bind.matched, requestedBy: v.email,
    });
    console.info(`[mcp-action] ${v.email} via Claude: add ${bind.matched} agents to campaign #${bind.campaignId} (job ${job.id})`);
    return { job: job.id, campaign: bind.campaignName, number: bind.campaignId, agents: bind.matched, note: "Adding has started in the background. Ask for its progress any time (campaign_agent_jobs)." };
  },
};
