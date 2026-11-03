import { randomUUID } from "node:crypto";

import { suggestProspectsCampaign } from "@/lib/clients/campaign-lists/rules";
import { osTable } from "@/lib/clients/os-db";
import { allCampaignsOfClient, campaignsOfClient } from "@/lib/clients/pause-campaigns";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isDemoPortal } from "@/lib/crm-preview/demo";
import { marketContext } from "@/lib/crm-preview/market";
import { attachLeads, removeLeads, type MembershipResult } from "@/lib/tools/analytics/campaigns/lead-membership";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors";
import { analyticsTeamId } from "@/lib/tools/analytics/supabase";
import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

import { loadLeadAgents, type SyncAgent } from "./agents.ts";
import { byPriority, databaseEmail, mapAgentToBisonLead, PRIORITY_ORDERS, type BisonLeadPayload, type LeadAgent } from "./lead-map.ts";
import { postToPortalChannel, type ShownCampaign } from "./queue.ts";
import { agentMarkets, campaignPerMls, campaignResultSlackText, chunks, IN_SEQUENCE, parseByMls, setupCampaignSlackText, syncMode, SWITCH_ENV, whyLeftOut, type CampaignOutcome, type CampaignPick, type Env } from "./rules.ts";
import { ensureSetupCampaign, type SetupClient, type SetupOutcome } from "./setup-campaign.ts";

/*
 * The background run (instrumentation.ts, every minute on Railway, only with OS_PROSPECT_SYNC=1): works off the
 * Prospects changes the portals recorded (queue.ts), oldest first — at most PER_PORTAL of a portal's a run, so one busy
 * portal never holds up the rest; a change waiting (for a campaign, for setup to finish, outside the test fence) steps
 * aside for WAIT_MS.
 *
 *   remove  the agent comes out of THIS client's own EmailBison campaigns (the user, 2 Nov: always — whatever its
 *           status there): its leads found by exact address (findLeadsByEmail), taken off with the audited
 *           removeLeads; the agent database's record of it in those campaigns is dropped at once, so Prospects no
 *           longer lists it (the Database app's sync would only notice in up to 6 hours). Also looked for: the
 *           campaigns this sync put it in, and the ones the portal showed it in when it was taken off — a lead found in
 *           one of those that is no longer mapped to the client is never touched, and our team's bell rings.
 *   add     the agent goes into the client's Prospects campaign — the one the team chose on its Campaigns tab, else the
 *           one made at setup, else the pre-selected one; a client with NO campaign at all (any platform, any mapping)
 *           that finished setup gets its first, a draft (setup-campaign.ts). A client with several MLSs has a campaign
 *           per market: the agent goes into the one picked for its MLS (the user, 3 Nov) — never a guess. As a lead
 *           the Database app's worker makes it (lead-map.ts), with the database's own email (no paid check); an agent
 *           already in one of the client's campaigns — asked of EmailBison, live, as the worker asks — is left there,
 *           and a lead EmailBison has already, in other campaigns, is added as it is: never rewritten (its fields may
 *           be what another client's emails show).
 *
 * THE LIST DECIDES (3 Nov audits): per agent, the newest change that matches the portal's Prospects as they are NOW
 * is the one done — on the list: added; off it: removed — and the others are set aside. The save records before it
 * changes the list, so a change whose save failed is never done; an agent whose newest change the list doesn't show
 * yet — young, or not yet due — waits a moment rather than being decided past it.
 *
 * Each row is claimed before anything is done (a conditional update), so two runs never do the same work; a run that
 * died gives its rows back after STALE_MS. A failure is tried again with growing waits (BACKOFF_MIN, about a day in
 * all), then left failed — and our team's bell rings.
 *
 * WHAT EMAILBISON WON'T TAKE (4 Nov, the user): a lead that has bounced or unsubscribed is final. One held by another
 * campaign's sequence is not — it stays pending and is looked at again every SEQUENCE_WAIT_MS until it can go in, or the
 * list says otherwise (off Prospects: not added), or it bounces, or the client churns. Said in the post once: a row held
 * once keeps its email, and nothing else writes one on a row still pending.
 */

export const ACTOR = "portal prospects";
/** Portals a run takes a share of, and each one's share. */
export const PORTALS_PER_RUN = 50;
export const PER_PORTAL = 500;
export const STALE_MS = 15 * 60_000;
export const WAIT_MS = 10 * 60_000;
/** A change younger than this that the list doesn't show yet is waited for (its save may still be writing). */
export const YOUNG_MS = 10 * 60_000;
export const SETTLE_MS = 2 * 60_000;
/** The wait before each next try, in minutes; after the last, the change is failed. */
export const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720] as const;
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
export const LOOKUP_TIMEOUT_MS = 45_000;
/** A lead another campaign's sequence holds is asked for again this long after (4 Nov, the user: weekly). */
export const SEQUENCE_WAIT_MS = 7 * 24 * 60 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

export interface Ctx {
  portalId: string;
  portalName: string;
  client: { id: string; name: string } | null;
  mlsIds: string[];
  /** The client's MLSs (the agent database's codes, as the portal resolves them), in the client's order. */
  mlsCodes: string[];
  orchClientId: string | null;
}
export interface ClientRecord { name: string; aliases: string[]; areas: string[]; mls: string[]; analyticsClientId: string | null; healthClientId: string | null; status?: string | null }
export interface Campaign { id: string; name: string; status: string }
type FoundLead = { id: number; email: string; status?: string | null; campaigns: Array<{ campaignId: number; status: string | null }> };
export interface Choices { single: CampaignPick | null; byMls: Record<string, CampaignPick> }

export interface RunDeps {
  env?: Env;
  now?: () => Date;
  /** The portals with changes due now, longest-waiting first (migration 0046's os_prospect_sync_due_portals). */
  duePortals?: (now: Date, limit: number) => Promise<string[]>;
  context?: (portalId: string) => Promise<Ctx | null>;
  clientRecord?: (osClientId: string) => Promise<ClientRecord | null>;
  timeZone?: (healthClientId: string) => Promise<string | null>;
  /** The client's own EmailBison campaigns that still exist (Analytics' mapping, strict — never an excluded or ambiguous one). */
  campaigns?: (client: ClientRecord) => Promise<Campaign[]>;
  /** Every campaign the client has on any platform under any mapping (a first campaign is made only when there are none). */
  allCampaigns?: (client: ClientRecord) => Promise<Array<Campaign & { platform: string }>>;
  /** The client's campaigns routed to a portal (os_campaign_portals, EmailBison) — for a client with several portals. */
  routes?: (osClientId: string) => Promise<Array<{ campaignId: string; portalId: string }>>;
  /** The campaign the onboarding app built for the client, if it built one (orch_clients.bison_campaign_id). */
  orchCampaign?: (orchClientId: string) => Promise<string | null>;
  /** The team's picks on the Campaigns tab: one Prospects campaign, and one per MLS for a client with several. */
  choices?: (osClientId: string) => Promise<Choices>;
  /** The campaigns made at setup, ready: by MLS code ("" for a client with one market). */
  readySetupCampaigns?: (osClientId: string) => Promise<Map<string, CampaignPick>>;
  setupFinished?: (portalId: string) => Promise<boolean>;
  setupCampaign?: (client: SetupClient, o: { by: string; test: boolean }) => Promise<SetupOutcome>;
  /** Which of these agents are on the portal's Prospects list (os_demo_prospects). */
  onProspects?: (portalId: string, agentIds: readonly string[]) => Promise<Set<string>>;
  loadAgents?: (ids: readonly string[], o: { mlsScope?: readonly string[] | null }) => Promise<Map<string, SyncAgent>>;
  upsertLeads?: (leads: readonly BisonLeadPayload[]) => Promise<Array<{ id: number; email: string }>>;
  findLeads?: (email: string) => Promise<FoundLead[]>;
  attach?: (campaignId: number, leadIds: number[], actor: string) => Promise<MembershipResult>;
  remove?: (campaignId: number, leadIds: number[], actor: string) => Promise<MembershipResult>;
  /** Drop the agent database's record of these agents in these campaigns. */
  forgetCampaignLeads?: (orchClientId: string, agentIds: readonly string[], campaignIds: readonly string[]) => Promise<void>;
  slack?: (text: string) => Promise<unknown>;
  bell?: (row: { kind: string; severity: string; title: string; body: string; ref: string }) => Promise<void>;
}

export interface RunResult {
  off?: string;
  portals: number;
  claimed: number;
  done: number;
  skipped: number;
  failed: number;
  waiting: number;
  notes: string[];
}

interface QueueRow {
  id: number; portal_id: string; os_client_id: string | null; agent_id: string; action: "add" | "remove"; source: "setup" | "prospects";
  requested_by: string; attempts: number; test: boolean; created_at: string; in_campaigns: ShownCampaign[] | null; email: string | null;
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------------------------------- the real deps --- */

function realDeps(d: RunDeps) {
  const eb = () => createEmailBisonClient();
  const extra = (c: ClientRecord) => (c.analyticsClientId ? [c.analyticsClientId] : []);
  return {
    env: d.env ?? process.env,
    now: d.now ?? (() => new Date()),
    duePortals: d.duePortals ?? (async (now: Date, limit: number) => {
      const { data, error } = await createAdminSupabase().rpc("os_prospect_sync_due_portals", { p_now: now.toISOString(), p_limit: limit });
      if (error) throw new Error(`os_prospect_sync_due_portals: ${error.message}`);
      return ((data ?? []) as Array<{ portal_id: string }>).map((r) => String(r.portal_id));
    }),
    context: d.context ?? (async (portalId: string): Promise<Ctx | null> => {
      const c = await marketContext(portalId);
      return c ? { portalId, portalName: c.portal.name, client: c.client, mlsIds: c.mls.ids, mlsCodes: c.mls.matched.map((m) => m.code), orchClientId: c.orchClientId } : null;
    }),
    clientRecord: d.clientRecord ?? (async (osClientId: string): Promise<ClientRecord | null> => {
      const { data, error } = await osTable("os_clients").select("name, status, aliases, areas, mls_codes, an_client_id, ch_client_id").eq("id", osClientId).maybeSingle();
      if (error) throw new Error(`os_clients: ${error.message}`);
      const r = data as Record<string, unknown> | null;
      if (!r) return null;
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
      return { name: s(r.name), aliases: list(r.aliases), areas: list(r.areas), mls: list(r.mls_codes), analyticsClientId: s(r.an_client_id) || null, healthClientId: s(r.ch_client_id) || null, status: s(r.status) || null };
    }),
    timeZone: d.timeZone ?? (async (healthClientId: string) => {
      const { data } = await getClientHealthSupabase().from("clients").select("time_zone").eq("id", healthClientId).maybeSingle();
      return s((data as { time_zone?: unknown } | null)?.time_zone) || null;
    }),
    campaigns: d.campaigns ?? (async (client: ClientRecord) =>
      (await campaignsOfClient(client, extra(client))).filter((c) => c.platform === "emailbison").map((c) => ({ id: c.id, name: c.name, status: c.status }))),
    allCampaigns: d.allCampaigns ?? (async (client: ClientRecord) =>
      (await allCampaignsOfClient(client, extra(client))).map((c) => ({ platform: c.platform, id: c.id, name: c.name, status: c.status }))),
    routes: d.routes ?? (async (osClientId: string) => {
      const { data, error } = await osTable("os_campaign_portals").select("platform, campaign_id, mi_client_id").eq("os_client_id", osClientId);
      if (error) throw new Error(`os_campaign_portals: ${error.message}`);
      return ((data ?? []) as Array<{ platform: string; campaign_id: string; mi_client_id: string }>).filter((r) => r.platform === "emailbison").map((r) => ({ campaignId: String(r.campaign_id), portalId: String(r.mi_client_id) }));
    }),
    orchCampaign: d.orchCampaign ?? (async (orchClientId: string) => {
      // Unreadable is not "none": a client whose only campaign the onboarding app built must never get a second.
      const { data, error } = await getCorofySupabase().from("orch_clients").select("bison_campaign_id").eq("id", orchClientId).maybeSingle();
      if (error) throw new Error(`orch_clients: ${error.message}`);
      return s((data as { bison_campaign_id?: unknown } | null)?.bison_campaign_id) || null;
    }),
    choices: d.choices ?? (async (osClientId: string): Promise<Choices> => {
      const { data, error } = await osTable("os_campaign_list_clients").select("prospects_campaign_id, prospects_campaign_name, prospects_by_mls").eq("os_client_id", osClientId).maybeSingle();
      if (error) throw new Error(`os_campaign_list_clients: ${error.message}`);
      const r = data as { prospects_campaign_id?: unknown; prospects_campaign_name?: unknown; prospects_by_mls?: unknown } | null;
      const id = s(r?.prospects_campaign_id);
      return { single: id ? { id, name: s(r?.prospects_campaign_name) || id } : null, byMls: parseByMls(r?.prospects_by_mls) };
    }),
    readySetupCampaigns: d.readySetupCampaigns ?? (async (osClientId: string) => {
      const { data, error } = await osTable("os_setup_campaigns").select("mls_code, status, campaign_id, campaign_name").eq("os_client_id", osClientId);
      if (error) throw new Error(`os_setup_campaigns: ${error.message}`);
      const out = new Map<string, CampaignPick>();
      for (const r of (data ?? []) as Array<{ mls_code: string | null; status: string; campaign_id: string | null; campaign_name: string | null }>) {
        if (r.status === "ready" && r.campaign_id) out.set(s(r.mls_code), { id: r.campaign_id, name: r.campaign_name ?? r.campaign_id });
      }
      return out;
    }),
    setupFinished: d.setupFinished ?? (async (portalId: string) => {
      // The portal's offer is written by "Finish setup" (crm-preview/portal-save.ts saveOffer).
      const { data, error } = await createAdminSupabase().from("os_portal_offers").select("portal_id").eq("portal_id", portalId).limit(1);
      if (error) throw new Error(`os_portal_offers: ${error.message}`);
      return ((data ?? []) as unknown[]).length > 0;
    }),
    setupCampaign: d.setupCampaign ?? ((client: SetupClient, o: { by: string; test: boolean }) => ensureSetupCampaign(client, o)),
    onProspects: d.onProspects ?? (async (portalId: string, agentIds: readonly string[]) => {
      const out = new Set<string>();
      for (const part of chunks([...new Set(agentIds)], 150)) {
        const { data, error } = await createAdminSupabase().from("os_demo_prospects").select("agent_id").eq("portal_id", portalId).in("agent_id", part);
        if (error) throw new Error(`os_demo_prospects: ${error.message}`);
        for (const r of (data ?? []) as Array<{ agent_id: string }>) out.add(String(r.agent_id));
      }
      return out;
    }),
    loadAgents: d.loadAgents ?? ((ids: readonly string[], o: { mlsScope?: readonly string[] | null }) => loadLeadAgents(ids, o)),
    upsertLeads: d.upsertLeads ?? (async (leads: readonly BisonLeadPayload[]) => {
      const r = await eb().upsertLeads(leads as unknown as Array<Record<string, unknown>>, "patch");
      return (r?.data ?? []).map((l) => ({ id: Number(l.id), email: s(l.email).toLowerCase() })).filter((l) => Number.isInteger(l.id) && l.id > 0 && l.email);
    }),
    // A lookup that hangs never holds the run: given up after LOOKUP_TIMEOUT_MS (the rows are tried again later).
    findLeads: d.findLeads ?? ((email: string) => withTimeout(eb().findLeadsByEmail(email), LOOKUP_TIMEOUT_MS, "EmailBison lead search timed out")),
    attach: d.attach ?? ((campaignId: number, leadIds: number[], actor: string) => attachLeads(campaignId, leadIds, actor, analyticsTeamId())),
    remove: d.remove ?? ((campaignId: number, leadIds: number[], actor: string) => removeLeads(campaignId, leadIds, actor, analyticsTeamId())),
    forgetCampaignLeads: d.forgetCampaignLeads ?? (async (orchClientId: string, agentIds: readonly string[], campaignIds: readonly string[]) => {
      if (!agentIds.length || !campaignIds.length) return;
      for (const part of chunks([...agentIds], 150)) {
        const { error } = await getCorofySupabase().from("bison_client_leads").delete().eq("client_id", orchClientId).in("agent_id", part).in("campaign_id", [...campaignIds]);
        if (error) throw new Error(`bison_client_leads: ${error.message}`);
      }
    }),
    slack: d.slack ?? postToPortalChannel,
    // The bell takes info, warning or critical (migration 0030's CHECK) — a refused one is logged, never lost silently.
    bell: d.bell ?? (async (row: { kind: string; severity: string; title: string; body: string; ref: string }) => {
      const { error } = await osTable("os_notifications").upsert(row, { onConflict: "ref", ignoreDuplicates: true });
      if (error) console.error(JSON.stringify({ tag: "[prospect-sync] bell not saved", ref: row.ref, title: row.title, error: error.message }));
    }),
  };
}
type Deps = ReturnType<typeof realDeps>;

/* ----------------------------------------------------------------------------------------------- the queue --- */

const iso = (t: number) => new Date(t).toISOString();

async function setRows(ids: readonly number[], token: string | null, patch: Record<string, unknown>, now: Date): Promise<void> {
  for (const part of chunks([...ids], 200)) {
    let q = osTable("os_prospect_sync").update({ ...patch, updated_at: now.toISOString() }).in("id", part);
    q = token === null ? q.eq("status", "pending") : q.eq("claim_token", token);
    const { error } = await q;
    if (error) throw new Error(`os_prospect_sync: ${error.message}`);
  }
}

/** One portal's run: its rows, its claim, what became of them. */
class Batch {
  failedFor: Array<{ row: QueueRow; why: string }> = [];
  /** What became of each change in the campaign this run — the "Campaign updated" post (3 Nov). */
  outcomes: Array<{ row: QueueRow; outcome: CampaignOutcome }> = [];
  /** Agents' names, as they are loaded — for that post. */
  names = new Map<string, string>();
  // Assigned in the constructor, not as parameter properties: Node's type stripping (the test runner) refuses those.
  readonly token: string;
  readonly now: Date;
  readonly out: RunResult;
  constructor(token: string, now: Date, out: RunResult) {
    this.token = token;
    this.now = now;
    this.out = out;
  }
  /** Finished — done, skipped or failed for good — and released from the claim. */
  async finish(rows: readonly QueueRow[], status: "done" | "skipped" | "failed", detail: string, extra: Record<string, unknown> = {}, outcome?: CampaignOutcome) {
    if (!rows.length) return;
    // Said in the post: what the change did to the campaign (a failure always; the list's own reconciling never).
    for (const r of rows) {
      const o = outcome ?? (status === "failed" ? { kind: "failed" as const, action: r.action } : null);
      if (o) this.outcomes.push({ row: r, outcome: o });
    }
    await setRows(rows.map((r) => r.id), this.token, { status, detail: detail.slice(0, 1000), processed_at: this.now.toISOString(), claim_token: null, claimed_at: null, next_try_at: null, ...extra }, this.now);
    if (status === "done") this.out.done += rows.length;
    else if (status === "skipped") this.out.skipped += rows.length;
    else { this.out.failed += rows.length; for (const r of rows) this.failedFor.push({ row: r, why: detail }); }
  }
  /**
   * Not yet: waiting (for a campaign, for setup) steps aside, no attempt counted — and so do this portal's other adds
   * due now (the same wait holds them all), so a portal with thousands waiting never fills a run.
   */
  async wait(rows: readonly QueueRow[], detail: string) {
    if (!rows.length) return;
    const until = iso(this.now.getTime() + WAIT_MS);
    await setRows(rows.map((r) => r.id), this.token, { status: "pending", detail: detail.slice(0, 1000), claim_token: null, claimed_at: null, next_try_at: until }, this.now);
    const rest = await osTable("os_prospect_sync").update({ detail: detail.slice(0, 1000), next_try_at: until, updated_at: this.now.toISOString() })
      .eq("portal_id", rows[0].portal_id).eq("status", "pending").eq("action", "add").or(`next_try_at.is.null,next_try_at.lte.${this.now.toISOString()}`);
    if (rest.error) throw new Error(`os_prospect_sync: ${rest.error.message}`);
    this.out.waiting += rows.length;
  }
  /**
   * Not yet, for these rows alone, for WAIT_MS: one market's adds waiting (a client with several MLSs) — the portal's
   * other markets go on (a portal-wide wait would let one market's backlog hold the others up for good).
   */
  async hold(rows: readonly QueueRow[], detail: string) {
    if (!rows.length) return;
    await setRows(rows.map((r) => r.id), this.token, { status: "pending", detail: detail.slice(0, 1000), claim_token: null, claimed_at: null, next_try_at: iso(this.now.getTime() + WAIT_MS) }, this.now);
    this.out.waiting += rows.length;
  }
  /** Not yet, for these rows alone (their list change hasn't landed, or a later change is coming): back in a moment. */
  async later(rows: readonly QueueRow[], detail: string, until?: string) {
    if (!rows.length) return;
    const soon = iso(this.now.getTime() + SETTLE_MS);
    await setRows(rows.map((r) => r.id), this.token, { status: "pending", detail: detail.slice(0, 1000), claim_token: null, claimed_at: null, next_try_at: until && until > soon ? until : soon }, this.now);
    this.out.waiting += rows.length;
  }
  /**
   * Held by another campaign's sequence: back in a week, for as long as that takes (no attempt counted — a passing
   * failure is counted afresh). Said in the post the first time only: a week with nothing new posts nothing.
   */
  async nextWeek(row: QueueRow, detail: string, extra: Record<string, unknown>, outcome: CampaignOutcome) {
    if (!row.email) this.outcomes.push({ row, outcome });
    await setRows([row.id], this.token, { status: "pending", detail: detail.slice(0, 1000), claim_token: null, claimed_at: null, attempts: 0, next_try_at: iso(this.now.getTime() + SEQUENCE_WAIT_MS), ...extra }, this.now);
    this.out.waiting += 1;
  }
  /** Failed this time: tried again after a growing wait — or, the last attempt, failed for good. */
  async retry(rows: readonly QueueRow[], detail: string) {
    const byAttempt = new Map<number, QueueRow[]>();
    for (const r of rows) byAttempt.set(r.attempts, [...(byAttempt.get(r.attempts) ?? []), r]);
    for (const [attempts, group] of byAttempt) {
      const next = attempts + 1;
      if (next >= MAX_ATTEMPTS) {
        await this.finish(group, "failed", `${detail} (gave up after ${next} tries)`, { attempts: next });
        continue;
      }
      await setRows(group.map((r) => r.id), this.token, { status: "pending", detail: detail.slice(0, 1000), claim_token: null, claimed_at: null, attempts: next, next_try_at: iso(this.now.getTime() + BACKOFF_MIN[attempts] * 60_000) }, this.now);
    }
  }
}

/* ------------------------------------------------------------------------------------------------- the run --- */

export async function runProspectSync(deps: RunDeps = {}): Promise<RunResult> {
  const x = realDeps(deps);
  const out: RunResult = { portals: 0, claimed: 0, done: 0, skipped: 0, failed: 0, waiting: 0, notes: [] };
  if ((x.env[SWITCH_ENV] ?? "").trim() !== "1") return { ...out, off: `${SWITCH_ENV} is not 1` };
  const now = x.now();

  // A claim whose run died: back in the queue.
  const stale = await osTable("os_prospect_sync").update({ status: "pending", claim_token: null, claimed_at: null, updated_at: now.toISOString() })
    .eq("status", "working").lt("claimed_at", iso(now.getTime() - STALE_MS));
  if (stale.error) throw new Error(`os_prospect_sync: ${stale.error.message}`);

  // A share of each portal with changes due now (never one waiting out its wait), oldest first.
  const due = (now: Date) => `next_try_at.is.null,next_try_at.lte.${now.toISOString()}`;
  for (const portalId of await x.duePortals(now, PORTALS_PER_RUN)) {
    // Outside the test fence (or the Demo): left as they are, all of them out of the way for a while.
    if (syncMode(portalId, isDemoPortal(portalId), x.env) === "off") {
      const aside = await osTable("os_prospect_sync").update({ next_try_at: iso(now.getTime() + WAIT_MS), updated_at: now.toISOString() })
        .eq("portal_id", portalId).eq("status", "pending").or(due(now));
      if (aside.error) throw new Error(`os_prospect_sync: ${aside.error.message}`);
      continue;
    }
    const { data, error } = await osTable("os_prospect_sync")
      .select("id, portal_id, os_client_id, agent_id, action, source, requested_by, attempts, test, created_at, in_campaigns, email")
      .eq("portal_id", portalId).eq("status", "pending").or(due(now))
      // First due, first done (3 Nov audit): a change set aside re-joins at the back — a market's backlog waiting for a
      // pick can never keep the portal's newer changes (its removals among them) from their turn.
      .order("next_try_at", { ascending: true, nullsFirst: true }).order("id", { ascending: true }).limit(PER_PORTAL);
    if (error) throw new Error(`os_prospect_sync: ${error.message}`);
    const pending = ((data ?? []) as QueueRow[]).map((r) => ({ ...r, id: Number(r.id), attempts: Number(r.attempts) || 0, in_campaigns: Array.isArray(r.in_campaigns) ? r.in_campaigns : null }));
    if (!pending.length) continue;
    const token = randomUUID();
    const claimed: QueueRow[] = [];
    for (const part of chunks(pending, 200)) {
      const { data: got, error: cErr } = await osTable("os_prospect_sync")
        .update({ status: "working", claim_token: token, claimed_at: new Date().toISOString(), updated_at: now.toISOString() })
        .in("id", part.map((r) => r.id)).eq("status", "pending").select("id");
      if (cErr) throw new Error(`os_prospect_sync: ${cErr.message}`);
      const mine = new Set(((got ?? []) as Array<{ id: number }>).map((r) => Number(r.id)));
      claimed.push(...part.filter((r) => mine.has(r.id)));
    }
    if (!claimed.length) continue;
    out.portals++;
    out.claimed += claimed.length;
    // This portal's own clock (a run can take minutes): its waits and retries count from now, not the run's start.
    const batch = new Batch(token, x.now(), out);
    let client = portalId;
    try {
      client = await runPortal(x, portalId, claimed, batch);
    } catch (err) {
      // Anything unexpected: every row still claimed goes back, an attempt counted.
      const why = `Stopped: ${err instanceof Error ? err.message : String(err)}`;
      const { data: still } = await osTable("os_prospect_sync").select("id").eq("claim_token", token);
      const left = new Set(((still ?? []) as Array<{ id: number }>).map((r) => Number(r.id)));
      await batch.retry(claimed.filter((c) => left.has(c.id)), why);
      out.notes.push(`${portalId}: ${why}`);
    }
    // The campaign changes this run made for this client: one post to #portal-update (3 Nov — after the "Prospects updated"
    // one sent when the client edited). Never fails the run.
    if (batch.outcomes.length) {
      const text = campaignResultSlackText({
        client, test: syncMode(portalId, false, x.env) === "test",
        outcomes: batch.outcomes.map(({ row, outcome }) => ({ name: batch.names.get(row.agent_id) ?? "an agent", outcome })),
      });
      if (text) await x.slack(text).catch(() => {});
    }
    // Given up on: our team hears — removals and adds each their own notice, at most one of each an hour per portal
    // (a removal's never hidden behind an add's): a removal said plainly — that agent may still be emailed.
    const hour = now.toISOString().slice(0, 13);
    const removals = batch.failedFor.filter((f) => f.row.action === "remove");
    const additions = batch.failedFor.filter((f) => f.row.action === "add");
    if (removals.length) {
      await x.bell({
        kind: "prospect_sync", severity: "critical", title: `Prospects removal not done — ${client}`,
        body: `${removals.length} agent${removals.length === 1 ? "" : "s"} taken off Prospects could not be taken out of the campaign — they may still be emailed. Last reason: ${removals.at(-1)!.why}`,
        ref: `prospect_sync:failed:remove:${portalId}:${hour}`,
      }).catch(() => {});
    }
    if (additions.length) {
      await x.bell({
        kind: "prospect_sync", severity: "warning", title: `Prospects not added to the campaign — ${client}`,
        body: `${additions.length} agent${additions.length === 1 ? "" : "s"} added to Prospects could not be added to the campaign. Last reason: ${additions.at(-1)!.why}`,
        ref: `prospect_sync:failed:add:${portalId}:${hour}`,
      }).catch(() => {});
    }
  }
  return out;
}

/** The changes recorded for these agents after the ones claimed, still waiting (not due yet): agent → its earliest due time. */
async function laterChanges(portalId: string, newestClaimed: ReadonlyMap<string, number>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...newestClaimed.keys()], 150)) {
    const { data, error } = await osTable("os_prospect_sync").select("id, agent_id, next_try_at").eq("portal_id", portalId).eq("status", "pending").in("agent_id", part);
    if (error) throw new Error(`os_prospect_sync: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: number; agent_id: string; next_try_at: string | null }>) {
      const agent = String(r.agent_id);
      if (Number(r.id) <= (newestClaimed.get(agent) ?? Infinity)) continue;
      const at = r.next_try_at ?? "";
      if (!out.has(agent) || at < out.get(agent)!) out.set(agent, at);
    }
  }
  return out;
}

/** One portal's claimed changes. Returns the client's name (for the bell). */
async function runPortal(x: Deps, portalId: string, claimed: QueueRow[], b: Batch): Promise<string> {
  const ctx = await x.context(portalId);
  // Unreadable (or gone): tried again — a moment's read error never loses the changes.
  if (!ctx) {
    await b.retry(claimed, "The portal could not be read just now — trying again.");
    return portalId;
  }
  if (!ctx.client) {
    await b.finish(claimed, "failed", "This portal is not linked to a client record.");
    return ctx.portalName;
  }
  const record = await x.clientRecord(ctx.client.id);
  if (!record) {
    await b.finish(claimed, "failed", "The client's record could not be read.");
    return ctx.client.name;
  }
  const client = record.name || ctx.client.name;

  // The client has left: a lead still waiting on another campaign's sequence is not added to its campaign months later.
  if (record.status === "churned") {
    const held = new Set(claimed.filter((r) => r.action === "add" && r.email).map((r) => r.agent_id));
    const waited = claimed.filter((r) => r.action === "add" && held.has(r.agent_id));
    await b.finish(waited, "skipped", `Not added: ${client} is no longer a client.`);
    claimed = claimed.filter((r) => !waited.includes(r));
    if (!claimed.length) return client;
  }

  // The list decides, per agent: the newest change that matches the list now is done; the rest are set aside. An agent
  // whose newest change the list may not show yet — a later one still waiting, or its newest young and not on the list
  // — waits, so nothing is decided past a change still landing (3 Nov audit).
  const byAgent = new Map<string, QueueRow[]>();
  for (const r of [...claimed].sort((a, z) => a.id - z.id)) byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r]);
  const coming = await laterChanges(portalId, new Map([...byAgent].map(([agent, rows]) => [agent, rows[rows.length - 1].id])));
  const listed = await x.onProspects(portalId, [...byAgent.keys()]);
  const toAdd: QueueRow[] = [];
  const toRemove: QueueRow[] = [];
  for (const [agentId, rows] of byAgent) {
    if (coming.has(agentId)) {
      await b.later(rows, "A later change for this agent is waiting — done together.", coming.get(agentId) || undefined);
      continue;
    }
    const want = listed.has(agentId) ? "add" : "remove";
    const newest = rows[rows.length - 1];
    if (newest.action !== want && b.now.getTime() - Date.parse(newest.created_at) < YOUNG_MS) {
      await b.later(rows, "Waiting for the Prospects list to show this change.");
      continue;
    }
    const match = [...rows].reverse().find((r) => r.action === want);
    if (match) {
      (want === "add" ? toAdd : toRemove).push(match);
      await b.finish(rows.filter((r) => r !== match), "skipped", `Replaced by a later change — the agent is ${want === "add" ? "on" : "off"} Prospects now.`);
      continue;
    }
    // Nothing matches the list, and the newest is old: its save didn't happen.
    await b.finish(rows, "skipped", want === "add" ? "Back on Prospects — left in the campaign." : "Not on Prospects — not added.");
  }
  if (!toRemove.length && !toAdd.length) return client;

  const test = syncMode(portalId, false, x.env) === "test";
  const [setups, choice, strict, all, routes, orch] = await Promise.all([
    x.readySetupCampaigns(ctx.client.id), x.choices(ctx.client.id), x.campaigns(record), x.allCampaigns(record), x.routes(ctx.client.id),
    ctx.orchClientId ? x.orchCampaign(ctx.orchClientId) : Promise.resolve(null),
  ]);
  // A client with several portals: this portal's changes go only to — and come only out of — campaigns routed here.
  const multiPortal = new Set(routes.map((r) => r.portalId)).size > 1 || routes.some((r) => r.portalId !== portalId);
  const routedHere = new Set(routes.filter((r) => r.portalId === portalId).map((r) => r.campaignId));
  const fits = (id: string) => !multiPortal || routedHere.has(id);
  // The team's picks, only while each is still one of the client's own campaigns (its strict mapping — an excluded
  // mapping is a campaign taken away from it — or one made at setup) and routed here: never trusted forever.
  const setupIds = new Set([...setups.values()].map((c) => c.id));
  const strictIds = new Set(strict.map((c) => c.id));
  const theirs = (p: CampaignPick | null | undefined): p is CampaignPick => !!p && (strictIds.has(p.id) || setupIds.has(p.id));
  const usable = (p: CampaignPick | null | undefined): p is CampaignPick => theirs(p) && fits(p.id);
  const strictHere = strict.filter((c) => fits(c.id));
  const single: Single = {
    chosen: usable(choice.single) ? choice.single : null,
    chosenGone: choice.single && !usable(choice.single) ? choice.single : null,
    setup: usable(setups.get("")) ? setups.get("")! : null,
    strict: strictHere,
  };
  // An MLS's pick is the team's word on where that market's agents go — taken even when the campaign goes to another of
  // the client's portals (its market lists every MLS of the client): the agent's market decides, its replies go there.
  const markets = new Map<string, Market>(ctx.mlsCodes.map((code) => {
    const pick = choice.byMls[code];
    return [code, { pick: theirs(pick) ? pick : null, gone: pick && !theirs(pick) ? pick : null, setup: theirs(setups.get(code)) ? setups.get(code)! : null }];
  }));
  // The client's own campaigns here: its strict mapping, and the ones the OS knows are its (made at setup, picked) —
  // removals only ever from those routed here (or put there by this portal's own adds: runRemoves).
  const own = new Map<string, Campaign>(strictHere.map((c) => [c.id, c]));
  for (const c of [single.setup, single.chosen, ...[...markets.values()].flatMap((m) => [m.pick, m.setup])]) if (c && fits(c.id) && !own.has(c.id)) own.set(c.id, { ...c, status: "unknown" });
  // A first campaign only for a client with none (any platform, any mapping, none the onboarding app built) — those made
  // at setup for its markets as they are now aside, so a client with several MLSs gets one for each. One made for an
  // earlier layout (its MLSs changed since) counts as a campaign: never a second draft beside it (3 Nov audit).
  const perMls = campaignPerMls(portalId, ctx.mlsCodes);
  const layout = new Set(perMls ? ctx.mlsCodes : [""]);
  const madeForLayout = new Set([...setups].filter(([key]) => layout.has(key)).map(([, c]) => c.id));
  const anyCampaign = all.some((c) => !madeForLayout.has(c.id)) || [...setups.keys()].some((key) => !layout.has(key)) || !!orch || multiPortal;

  if (toRemove.length) await runRemoves(x, ctx, client, [...own.values()], fits, toRemove, b);
  if (toAdd.length) {
    const where: Where = { single, markets, own: [...own.values()], anyCampaign };
    if (perMls) await runMarketAdds(x, ctx, record, client, where, toAdd, b, test);
    else await runAdds(x, ctx, record, client, where, toAdd, b, test);
  }
  return client;
}

/* -------------------------------------------------------------------------------------------------- removes --- */

/**
 * The agent's own addresses — its preferred and enriched ones, and the one a lead is made with (the worker's priority
 * address). Never every address its sources list: a source's team or office address can be another agent's own, and
 * that agent's lead would go too (3 Nov audit). The addresses its leads were made with (this sync's, and those the
 * campaigns' records give it) are added by the caller.
 */
function addressesOf(a: LeadAgent): string[] {
  const all = [a.enriched_email, a.preferred_email, byPriority(a as LeadAgent & Record<string, unknown>, PRIORITY_ORDERS.courted, "email", "preferred_email")];
  return [...new Set(all.map((e) => (typeof e === "string" ? e.trim().toLowerCase() : "")).filter((e) => EMAIL.test(e)))];
}

async function runRemoves(x: Deps, ctx: Ctx, client: string, own: Campaign[], fits: (id: string) => boolean, rows: QueueRow[], b: Batch): Promise<void> {
  // Where each agent was put by this sync (its address then, and the campaign) — looked in whatever the mapping says now.
  const put = new Map<string, Array<{ email: string; campaignId: string | null; campaignName: string | null }>>();
  for (const part of chunks(rows.map((r) => r.agent_id), 150)) {
    const { data, error } = await osTable("os_prospect_sync").select("agent_id, email, campaign_id, campaign_name").eq("portal_id", ctx.portalId).eq("action", "add").eq("status", "done").in("agent_id", part).not("email", "is", null);
    if (error) throw new Error(`os_prospect_sync: ${error.message}`);
    for (const r of (data ?? []) as Array<{ agent_id: string; email: string; campaign_id: string | null; campaign_name: string | null }>) {
      put.set(String(r.agent_id), [...(put.get(String(r.agent_id)) ?? []), { email: s(r.email).toLowerCase(), campaignId: s(r.campaign_id) || null, campaignName: s(r.campaign_name) || null }]);
    }
  }
  const shownOf = (r: QueueRow) => r.in_campaigns ?? [];
  const nothingToSearch = !own.length && !rows.some((r) => put.get(r.agent_id)?.some((p) => p.campaignId) || shownOf(r).length);
  if (nothingToSearch) {
    await b.finish(rows, "done", `Was in none of ${client}'s campaigns.`, {}, { kind: "none" });
    return;
  }
  const agents = await x.loadAgents(rows.map((r) => r.agent_id), {});
  for (const [id, a] of agents) if (a.full_name) b.names.set(id, a.full_name);

  // The client's own campaigns here — never changed below: each agent's own set is built from it afresh (3 Nov audit:
  // a campaign one agent may be taken out of must never become removable for the next).
  const ownHere = new Map(own.map((c) => [String(c.id), c]));
  const names = new Map<string, string>([...ownHere].map(([id, c]) => [id, c.name]));
  // Per agent: its leads in the campaigns it may be taken out of (exact address only); what else was seen.
  const plan = new Map<number, { found: Array<{ campaignId: string; leadId: number }>; strays: string[]; strayIds: string[]; stale: string[]; unknown: string[] }>();
  const lookupFailed: QueueRow[] = [];
  let lookupWhy = "";
  for (const r of rows) {
    const a = agents.get(r.agent_id);
    const ours = put.get(r.agent_id) ?? [];
    // Removable: only the client's own campaigns here. Looked in as well: the ones the portal showed it in (with the
    // addresses those leads have) and the ones this portal's sync once put it in — a lead in one of those that is not
    // the client's own here now (given to another client, re-routed) is never touched: said, and our team's bell rings
    // (3 Nov audits: an old add never makes another client's campaign removable).
    const removable = ownHere;
    const shown = shownOf(r).filter((c) => c.provider === "emailbison");
    const shownHere = new Map(shown.filter((c) => fits(c.id)).map((c) => [c.id, c.name ?? c.id]));
    const lookedIn = new Map(shownHere);
    for (const p of ours) if (p.campaignId && !lookedIn.has(p.campaignId)) lookedIn.set(p.campaignId, p.campaignName ?? p.campaignId);
    const emails = [...new Set([...(a ? addressesOf(a) : []), ...ours.map((p) => p.email), ...shown.flatMap((c) => c.emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL.test(e))])];
    const found: Array<{ campaignId: string; leadId: number }> = [];
    const strays = new Set<string>();
    // EmailBison failed a lookup already this batch: the rest are tried again later, not each waiting out its retries.
    if (lookupFailed.length) { lookupFailed.push(r); continue; }
    try {
      for (const email of emails) {
        for (const lead of await x.findLeads(email)) {
          if (lead.email.trim().toLowerCase() !== email) continue;
          for (const lc of lead.campaigns) {
            const id = String(lc.campaignId);
            if (removable.has(id)) { found.push({ campaignId: id, leadId: lead.id }); names.set(id, removable.get(id)!.name); }
            else if (lookedIn.has(id)) strays.add(id);
          }
        }
      }
      // Shown in a campaign here, but EmailBison has no lead of it there: searched under the address that campaign's
      // lead has, the record is out of date — said, and dropped with the rest; with that address unknown, it can't be
      // told apart from a lead under an address we don't have — failed, and our team's bell rings (3 Nov audit).
      const notThere = [...shownHere.keys()].filter((id) => !strays.has(id) && !found.some((f) => f.campaignId === id));
      const known = (id: string) => shown.some((c) => c.id === id && (c.emails ?? []).length > 0);
      for (const id of notThere) if (!names.has(id)) names.set(id, shownHere.get(id)!);
      plan.set(r.id, {
        found: [...new Map(found.map((f) => [`${f.campaignId}:${f.leadId}`, f])).values()],
        strays: [...strays].map((id) => lookedIn.get(id)!),
        strayIds: [...strays],
        stale: notThere.filter(known),
        unknown: notThere.filter((id) => !known(id)).map((id) => shownHere.get(id)!),
      });
    } catch (err) {
      lookupFailed.push(r);
      lookupWhy = describeEmailBisonError(err);
    }
  }
  if (lookupFailed.length) await b.retry(lookupFailed, `EmailBison could not be searched just now (${lookupWhy}) — trying again.`);

  // Campaign by campaign, every lead at once — the audited removal (it confirms an "already off" twice before saying so).
  const perCampaign = new Map<string, number[]>();
  for (const [, p] of plan) for (const f of p.found) perCampaign.set(f.campaignId, [...(perCampaign.get(f.campaignId) ?? []), f.leadId]);
  const failedCampaigns = new Map<string, string>();
  for (const [campaignId, leadIds] of perCampaign) {
    try {
      const res = await x.remove(Number(campaignId), [...new Set(leadIds)], ACTOR);
      if (!res.ok) failedCampaigns.set(campaignId, res.chunks.find((c) => !c.ok)?.error ?? "EmailBison refused the removal.");
    } catch (err) {
      failedCampaigns.set(campaignId, describeEmailBisonError(err));
    }
  }

  // Each agent's record dropped for exactly the campaigns it left (or was only on record in) — never another's.
  const forget = new Map<string, string[]>();
  const retry: QueueRow[] = [];
  for (const r of rows) {
    const p = plan.get(r.id);
    if (!p) continue; // its lookup failed — tried again above
    if (p.found.some((f) => failedCampaigns.has(f.campaignId))) { retry.push(r); continue; }
    const took = [...new Set(p.found.map((f) => names.get(f.campaignId) ?? f.campaignId))];
    const instantly = shownOf(r).filter((c) => c.provider !== "emailbison").map((c) => c.name ?? c.id);
    const elsewhere = shownOf(r).filter((c) => c.provider === "emailbison" && !fits(c.id) && !p.found.some((f) => f.campaignId === c.id) && !p.strayIds.includes(c.id)).map((c) => c.name ?? c.id);
    // What was done, then (a failure) what is wrong, then what else is known.
    const head = [
      took.length ? `Taken out of ${took.join(", ")}.` : `Was in none of ${client}'s campaigns.`,
      p.stale.length ? `Listed in ${p.stale.map((id) => names.get(id) ?? id).join(", ")}, but EmailBison has no lead of it there now.` : "",
    ];
    const tail = [
      instantly.length ? `Also listed in ${[...new Set(instantly)].join(", ")} (Instantly — not reached from here).` : "",
      elsewhere.length ? `Also in ${[...new Set(elsewhere)].join(", ")}, which goes to another of ${client}'s portals — left there.` : "",
    ];
    const result = { campaign_id: p.found.map((f) => f.campaignId).join(",") || null, campaign_name: took.join(", ") || null };
    if (p.strays.length || p.unknown.length) {
      const why = [
        p.strays.length ? `Still in ${p.strays.join(", ")} — not one of ${client}'s campaigns for this portal now, so not touched: check who it belongs to.` : "",
        p.unknown.length ? `Listed in ${p.unknown.join(", ")}, but no lead of it was found there under any address we have — check it there.` : "",
      ].filter(Boolean);
      await b.finish([r], "failed", [...head, ...why, ...tail].filter(Boolean).join(" "), result);
    } else {
      await b.finish([r], "done", [...head, ...tail].filter(Boolean).join(" "), result, took.length ? { kind: "removed", campaigns: took } : { kind: "none" });
    }
    const left = [...new Set([...p.found.map((f) => f.campaignId), ...p.stale])];
    if (left.length) forget.set(r.agent_id, left);
  }
  if (retry.length) {
    const why = [...new Set(retry.flatMap((r) => (plan.get(r.id)?.found ?? []).map((f) => failedCampaigns.get(f.campaignId)).filter(Boolean)))].join(" · ");
    await b.retry(retry, `Not taken out yet: ${why}`);
  }
  // So Prospects stops listing them now, not at the Database app's next sync — agents with the same campaigns together.
  if (ctx.orchClientId && forget.size) {
    const groups = new Map<string, { agents: string[]; campaigns: string[] }>();
    for (const [agent, campaigns] of forget) {
      const sorted = [...campaigns].sort();
      const key = sorted.join(",");
      groups.set(key, { agents: [...(groups.get(key)?.agents ?? []), agent], campaigns: sorted });
    }
    for (const g of groups.values()) {
      try {
        await x.forgetCampaignLeads(ctx.orchClientId, g.agents, g.campaigns);
      } catch (err) {
        b.out.notes.push(`forget: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/* ----------------------------------------------------------------------------------------------------- adds --- */

interface Single {
  chosen: CampaignPick | null;
  /** The team's choice when it is no longer one of the client's own campaigns (or routed to another portal). */
  chosenGone: CampaignPick | null;
  setup: CampaignPick | null;
  strict: Campaign[];
}
interface Market { pick: CampaignPick | null; gone: CampaignPick | null; setup: CampaignPick | null }
interface Where {
  single: Single;
  markets: Map<string, Market>;
  own: Campaign[];
  /** The client has some campaign (any platform, any mapping, or one the onboarding app built) — never a new one then. */
  anyCampaign: boolean;
}

const day = (b: Batch) => b.now.toISOString().slice(0, 10);
/* The Slack post's few words for why an agent wasn't added (databaseEmail's reasons). */
const SHORT_SKIP: Record<string, string> = { "no email in the agent database": "no email on file", "its email already failed a check": "email failed an earlier check" };
const tab = (client: string) => `its Campaigns tab (Clients → ${client} → Campaigns)`;

/** A client with one market: every add into its one Prospects campaign. */
async function runAdds(x: Deps, ctx: Ctx, record: ClientRecord, client: string, where: Where, rows: QueueRow[], b: Batch, test: boolean): Promise<void> {
  const w = where.single;
  // 0. The team's choice is gone (deleted, given to another client, routed to another portal): never guessed past —
  //    waits, and our team is asked to pick again.
  if (w.chosenGone) {
    const why = `The Prospects campaign chosen for ${client} (${w.chosenGone.name}) is no longer one of its campaigns that can take this portal's prospects — pick one again on ${tab(client)}.`;
    await b.wait(rows, `Waiting: ${why}`);
    await x.bell({ kind: "prospect_sync", severity: "warning", title: `Prospects waiting for a campaign — ${client}`, body: `${rows.length.toLocaleString("en-US")} prospects can't go into a campaign yet: ${why}`, ref: `prospect_sync:gone:${ctx.client!.id}:${day(b)}` }).catch(() => {});
    return;
  }
  // 1. Where they go: the team's choice, else the setup campaign, else the pre-selected one of its own.
  let target: CampaignPick | null = w.chosen ?? w.setup ?? suggestProspectsCampaign(w.strict);
  if (!target) {
    // The bell and the post count every add this portal has waiting — not only this run's share (500 of 4,657, 3 Nov).
    const made = await firstCampaign(x, ctx, record, client, where, null, rows.length + (await waitingAdds(ctx.portalId)), b, test);
    if ("wait" in made) {
      await b.wait(rows, `Waiting: ${made.wait}`);
      return;
    }
    target = made.campaign;
  }
  const agents = await x.loadAgents(rows.map((r) => r.agent_id), { mlsScope: ctx.mlsIds });
  await addInto(x, target, agents, rows, where.own, new Set(), b);
}

/** EmailBison refusing the leads themselves — each looked at to see why (judge), not a moment's trouble to try again. */
const REFUSED_LEADS = /in other sequences|previously bounced|unsubscribed/i;

/** This portal's other adds waiting for a campaign (claimed ones are "working"; one with an email waits on another campaign's sequence, not this); 0 when it can't be counted. */
async function waitingAdds(portalId: string): Promise<number> {
  const { count, error } = await osTable("os_prospect_sync").select("id", { count: "exact", head: true }).eq("portal_id", portalId).eq("status", "pending").eq("action", "add").is("email", null);
  return error ? 0 : count ?? 0;
}

/** A lead that can't go in, from what it shows now: another campaign's sequence → next week; bounced or unsubscribed → final, said why; nothing to go on → tried again. */
async function leftOut(into: CampaignPick, row: QueueRow, email: string, leadId: number, found: FoundLead[], b: Batch): Promise<void> {
  const why = whyLeftOut(found, into.id);
  const extra = { eb_lead_id: String(leadId), email };
  if (why.kind === "unknown") {
    await b.retry([row], `EmailBison didn't add it to ${into.name} and gave no reason — trying again.`);
    return;
  }
  if (why.kind === "sequence") {
    await b.nextWeek(row, `${IN_SEQUENCE} (campaign ${why.campaigns.join(", ")}): EmailBison won't add it to ${into.name} until that ends. Trying again every week.`, extra, { kind: "notAdded", reason: "in another campaign's sequence, trying again weekly" });
    return;
  }
  await b.finish([row], "skipped", `Not added to ${into.name}: the address has ${why.kind}.`, extra, { kind: "notAdded", reason: "bounced or unsubscribed" });
}

/**
 * EmailBison didn't take all of these: each judged on what its lead shows now, one by one (4 Nov review: a search that
 * lags or fails must never decide the others). In the campaign: added. Held, bounced, unsubscribed: that. Anything else
 * can't be told and is tried again — safe to repeat: a lead that did go in is then found there. A search that fails says
 * nothing about the rest, and they aren't each left to wait out its timeout.
 */
async function judge(x: Deps, into: CampaignPick, part: ReadonlyArray<{ l: { row: QueueRow; email: string }; id: number }>, b: Batch): Promise<void> {
  const unread: QueueRow[] = [];
  let unreadWhy = "";
  for (const { l, id } of part) {
    if (unread.length) { unread.push(l.row); continue; }
    try {
      const now = (await x.findLeads(l.email)).filter((f) => f.email.trim().toLowerCase() === l.email);
      if (now.some((f) => f.campaigns.some((c) => String(c.campaignId) === String(into.id)))) await b.finish([l.row], "done", `Added to ${into.name}.`, { campaign_id: into.id, campaign_name: into.name, eb_lead_id: String(id), email: l.email }, { kind: "added", campaign: into.name });
      else await leftOut(into, l.row, l.email, id, now, b);
    } catch (err) {
      unread.push(l.row);
      unreadWhy = describeEmailBisonError(err);
    }
  }
  if (unread.length) await b.retry(unread, `EmailBison could not be searched just now (${unreadWhy}) — trying again.`);
}

/** A client with several MLSs: each agent into the campaign picked (or made at setup) for its MLS — never a guess. */
async function runMarketAdds(x: Deps, ctx: Ctx, record: ClientRecord, client: string, where: Where, rows: QueueRow[], b: Batch, test: boolean): Promise<void> {
  const agents = await x.loadAgents(rows.map((r) => r.agent_id), { mlsScope: ctx.mlsIds });
  for (const [id, a] of agents) if (a.full_name) b.names.set(id, a.full_name);
  const into = new Map<string, { campaign: CampaignPick; rows: QueueRow[] }>();
  const needs = new Map<string, QueueRow[]>();
  for (const r of rows) {
    const a = agents.get(r.agent_id);
    if (!a) { await b.finish([r], "skipped", "This agent is no longer in the agent database.", {}, { kind: "notAdded", reason: "no longer in our database" }); continue; }
    const codes = agentMarkets(a.mls_all, ctx.mlsCodes);
    if (!codes.length) { await b.finish([r], "skipped", `Not in any of ${client}'s MLSs (${ctx.mlsCodes.join(", ")}) — not added.`, {}, { kind: "notAdded", reason: "outside their MLSs" }); continue; }
    // Its first MLS with a campaign; none: its first MLS decides what it waits for.
    const hit = codes.map((code) => where.markets.get(code)).map((m) => m?.pick ?? m?.setup ?? null).find(Boolean) ?? null;
    if (hit) into.set(hit.id, { campaign: hit, rows: [...(into.get(hit.id)?.rows ?? []), r] });
    else needs.set(codes[0], [...(needs.get(codes[0]) ?? []), r]);
  }
  for (const [code, waiting] of needs) {
    const m = where.markets.get(code);
    if (m?.gone) {
      const why = `The Prospects campaign picked for ${client}'s ${code} agents (${m.gone.name}) is no longer one of its campaigns — pick one again on ${tab(client)}.`;
      await b.hold(waiting, `Waiting: ${why}`);
      await x.bell({ kind: "prospect_sync", severity: "warning", title: `Prospects waiting for a campaign — ${client}`, body: `${waiting.length.toLocaleString("en-US")} ${code} prospects can't go into a campaign yet: ${why}`, ref: `prospect_sync:gone:${ctx.client!.id}:${code}:${day(b)}` }).catch(() => {});
      continue;
    }
    const made = await firstCampaign(x, ctx, record, client, where, code, waiting.length, b, test);
    if ("wait" in made) { await b.hold(waiting, `Waiting: ${made.wait}`); continue; }
    into.set(made.campaign.id, { campaign: made.campaign, rows: [...(into.get(made.campaign.id)?.rows ?? []), ...waiting] });
  }
  const seen = new Set<string>();
  for (const { campaign, rows: group } of into.values()) await addInto(x, campaign, agents, group, where.own, seen, b);
}

/**
 * No campaign to go into: a client with campaigns waits for the team's pick (the bell asks); one with none at all gets
 * its first — a draft (for one MLS of a client with several) — once it has finished setup.
 */
async function firstCampaign(x: Deps, ctx: Ctx, record: ClientRecord, client: string, where: Where, code: string | null, n: number, b: Batch, test: boolean): Promise<{ campaign: CampaignPick } | { wait: string }> {
  const count = `${n.toLocaleString("en-US")}${code ? ` ${code}` : ""} prospects`;
  const ask = (why: string, kind: string, severity = "warning", title = `Prospects waiting for a campaign — ${client}`) =>
    x.bell({ kind: "prospect_sync", severity, title, body: `${count} can't go into a campaign yet: ${why}`, ref: `prospect_sync:${kind}:${ctx.client!.id}${code ? `:${code}` : ""}:${day(b)}` }).catch(() => {});
  if (where.anyCampaign) {
    const why = code
      ? `${client} has campaigns, but none picked for its ${code} agents — pick one on ${tab(client)}.`
      : `${client} has campaigns, but none can take prospects — pick its Prospects campaign on ${tab(client)}.`;
    await ask(why, "pick");
    return { wait: why };
  }
  if (!(await x.setupFinished(ctx.portalId))) return { wait: `${client} has no campaign yet, and hasn't finished setting up its portal.` };
  const made = await x.setupCampaign({
    osClientId: ctx.client!.id, portalId: ctx.portalId, name: client, aliases: record.aliases, areas: record.areas, mls: record.mls,
    timeZone: record.healthClientId ? await x.timeZone(record.healthClientId).catch(() => null) : null, analyticsClientId: record.analyticsClientId, mlsCode: code,
  }, { by: ACTOR, test });
  if (made.kind === "waiting") {
    await ask(made.reason, "waiting");
    return { wait: made.reason };
  }
  if (made.kind === "failed") {
    // Until a person sorts it out (makes the campaign, or picks one on the Campaigns tab): waiting, not failed.
    await x.bell({ kind: "prospect_sync", severity: "critical", title: `First campaign not made — ${client}`, body: `${made.reason} Its prospects wait until a campaign is picked on its Campaigns tab.`, ref: `prospect_sync:setup_failed:${ctx.client!.id}${code ? `:${code}` : ""}:${day(b)}` }).catch(() => {});
    return { wait: made.reason };
  }
  const campaign = { id: made.campaignId, name: made.campaignName };
  if (!where.own.some((c) => c.id === campaign.id)) where.own.push({ ...campaign, status: "draft" });
  if (made.created) {
    await x.slack(setupCampaignSlackText({ client, campaign: made.campaignName, agents: n, test, blank: made.blank })).catch(() => {});
    if (made.note) await x.bell({ kind: "prospect_sync", severity: "warning", title: `First campaign needs a look — ${client}`, body: `${made.campaignName}: ${made.note}`, ref: `prospect_sync:setup_note:${ctx.client!.id}${code ? `:${code}` : ""}` }).catch(() => {});
  }
  return { campaign };
}

/** These agents into one campaign: as the worker makes leads — or, a lead EmailBison has in other campaigns, as it is. */
async function addInto(x: Deps, into: CampaignPick, agents: ReadonlyMap<string, SyncAgent>, rows: QueueRow[], own: Campaign[], seen: Set<string>, b: Batch): Promise<void> {
  // 1. The leads — the database's email; the market's own numbers.
  const leads: Array<{ row: QueueRow; email: string; payload: BisonLeadPayload }> = [];
  for (const r of rows) {
    const a = agents.get(r.agent_id);
    if (a?.full_name) b.names.set(r.agent_id, a.full_name);
    if (!a) { await b.finish([r], "skipped", "This agent is no longer in the agent database.", {}, { kind: "notAdded", reason: "no longer in our database" }); continue; }
    const e = databaseEmail(a);
    if ("skip" in e) { await b.finish([r], "skipped", `Not added: ${e.skip}.`, {}, { kind: "notAdded", reason: SHORT_SKIP[e.skip] ?? e.skip }); continue; }
    if (seen.has(e.email)) { await b.finish([r], "skipped", "Another prospect has the same email — added once.", {}, { kind: "notAdded", reason: "same email as another prospect" }); continue; }
    seen.add(e.email);
    leads.push({ row: r, email: e.email, payload: mapAgentToBisonLead(a, e.email, a.mls_code) });
  }

  // 2. Already in one of the client's own campaigns (asked of EmailBison now, as the worker asks): left there. One it
  //    won't take — in another campaign's sequence, bounced, unsubscribed — isn't asked for (the rule held for all 5,844
  //    agents synced by 4 Nov, whyLeftOut): half the calls, and no refused attach in the audit log every week. A lead
  //    EmailBison has in other campaigns: added as it is — its fields are what those campaigns' emails show, and may be
  //    another client's (3 Nov audit); one in no campaign, or new, is made or updated as the worker makes it.
  const ownIds = new Map(own.map((c) => [String(c.id), c]));
  const send: typeof leads = [];
  const asIs: Array<{ l: (typeof leads)[number]; id: number }> = [];
  const lookupFailed: QueueRow[] = [];
  let lookupWhy = "";
  for (const l of leads) {
    // EmailBison failed a lookup already this batch: the rest are tried again later, not each waiting out its retries.
    if (lookupFailed.length) { lookupFailed.push(l.row); continue; }
    try {
      const found = (await x.findLeads(l.email)).filter((f) => f.email.trim().toLowerCase() === l.email);
      const there = found.flatMap((f) => f.campaigns).map((c) => ownIds.get(String(c.campaignId))).find(Boolean);
      const inOthers = found.find((f) => f.campaigns.length > 0);
      const inInto = found.find((f) => f.campaigns.some((c) => String(c.campaignId) === String(into.id)));
      // Tried before, and in it now: this sync put it there and EmailBison's search lagged — on record as added, so a
      // later removal looks where it was put.
      if (inInto && l.row.attempts > 0) await b.finish([l.row], "done", `Added to ${into.name}.`, { campaign_id: into.id, campaign_name: into.name, eb_lead_id: String(inInto.id), email: l.email }, { kind: "added", campaign: into.name });
      else if (there) await b.finish([l.row], "done", there.id === into.id ? `Already in ${into.name}.` : `Already in ${there.name} — not added twice.`, { email: l.email }, { kind: "already", campaign: there.name });
      // In it already, whatever else holds it (a market's pick can go to another portal: not one of `own` here).
      else if (inInto) await b.finish([l.row], "done", `Already in ${into.name}.`, { email: l.email }, { kind: "already", campaign: into.name });
      else if (whyLeftOut(found, into.id).kind !== "unknown") await leftOut(into, l.row, l.email, found[0].id, found, b);
      else if (inOthers) asIs.push({ l, id: inOthers.id });
      else send.push(l);
    } catch (err) {
      lookupFailed.push(l.row);
      lookupWhy = describeEmailBisonError(err);
    }
  }
  if (lookupFailed.length) await b.retry(lookupFailed, `EmailBison could not be searched just now (${lookupWhy}) — trying again.`);

  // 3. Into EmailBison, 500 at a time: made or updated (only the fields sent change).
  const toAttach: Array<{ l: (typeof leads)[number]; id: number }> = [...asIs];
  for (const part of chunks(send, 500)) {
    let made: Array<{ id: number; email: string }>;
    try {
      made = await x.upsertLeads(part.map((l) => l.payload));
    } catch (err) {
      await b.retry(part.map((l) => l.row), `EmailBison did not take the leads: ${describeEmailBisonError(err)}`);
      continue;
    }
    const idOf = new Map(made.map((m) => [m.email.trim().toLowerCase(), m.id]));
    await b.finish(part.filter((l) => !idOf.has(l.email)).map((l) => l.row), "skipped", "EmailBison did not take this address (it refuses some personal-email domains).", {}, { kind: "notAdded", reason: "address refused by EmailBison" });
    for (const l of part) if (idOf.has(l.email)) toAttach.push({ l, id: idOf.get(l.email)! });
  }

  // 4. Attached to the campaign, 500 at a time.
  for (const part of chunks(toAttach, 500)) {
    let res: MembershipResult;
    try {
      res = await x.attach(Number(into.id), part.map((t) => t.id), ACTOR);
    } catch (err) {
      await b.retry(part.map((t) => t.l.row), `Not added to ${into.name} yet: ${describeEmailBisonError(err)}`);
      continue;
    }
    if (!res.ok) {
      const why = res.chunks.find((c) => !c.ok)?.error ?? "EmailBison refused it.";
      // EmailBison refusing every one of them, in one sentence for several reasons (3 Nov, live: Homebase's one Boston
      // agent): not a moment's trouble, and never all taken as one reason — each judged.
      if (REFUSED_LEADS.test(why)) await judge(x, into, part, b);
      else await b.retry(part.map((t) => t.l.row), `Not added to ${into.name} yet: ${why}`);
      continue;
    }
    // EmailBison answers "added" and quietly leaves out a lead it won't take: the campaign grew by less than asked.
    if (res.skipped > 0) {
      await judge(x, into, part, b);
      continue;
    }
    for (const { l, id } of part) await b.finish([l.row], "done", `Added to ${into.name}.`, { campaign_id: into.id, campaign_name: into.name, eb_lead_id: String(id), email: l.email }, { kind: "added", campaign: into.name });
  }
}
