import { randomUUID } from "node:crypto";

import { osTable } from "@/lib/clients/os-db";
import { loadLeadAgents, type SyncAgent } from "@/lib/clients/prospect-sync/agents";
import { databaseEmail, type LeadAgent } from "@/lib/clients/prospect-sync/lead-map";
import { portalsOf } from "@/lib/clients/usage-billing/leads";
import { addInto, BACKOFF_MIN, MAX_ATTEMPTS, prospectSyncDeps, type AddSink, type Campaign, type ProspectSyncDeps, type QueueRow } from "@/lib/clients/prospect-sync/run";
import type { CampaignOutcome } from "@/lib/clients/prospect-sync/rules";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isOpenStatus } from "@/lib/tools/analytics/campaigns/inbox-removal.ts";
import { attachLeads } from "@/lib/tools/analytics/campaigns/lead-membership";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { agentIdsPage, IDS_PAGE } from "@/lib/tools/assistant/tools-phase10";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";

/*
 * ADDING AGENTS FROM THE AGENT DATABASE TO A CAMPAIGN (28 Nov; the client: "creating a campaign and using leads on the
 * database"; the user: any campaign, no limit on the number of agents, the OS's own path, no enrichment).
 *
 * Claude's campaign_add_agents records one job (os_campaign_agent_jobs, migration 0059): the campaign and the agent
 * database filters it was confirmed with. This run, every minute:
 *   1. COLLECTING — every agent the filters match, IDS_PAGE a call (the Database app's fn_filter_ids, stable order),
 *      into the job's items. No cap: a job with more agents takes one page a minute until the last.
 *   2. ADDING — PER_RUN of the job's due items a minute, through prospect-sync's addInto: the agent database's own email
 *      (no paid check), a lead EmailBison already has added as it is (never rewritten — its fields may be what another
 *      client's emails show), new leads made as the Database app's worker makes them, the audited attach (named
 *      "<email> via Claude"), every refusal judged one by one. A campaign that belongs to a client: the agents on that
 *      client's DNC List, My Agents or pipeline are left out (the portal's Market rule), and an agent already in
 *      another of its campaigns isn't added twice.
 *   3. DONE — the totals on the job; the team's bell says so.
 * The campaign must still be able to send (draft, paused or active): finished or gone, the job stops and says why.
 * Each item is claimed before it is worked on, so overlapping runs never do the same agent twice.
 */

export const PER_RUN = 200;
const STALE_MS = 15 * 60_000;
const JOBS_PER_RUN = 5;
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown) => Number(v) || 0;
const lower = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
const personKey = (name: string | null | undefined) => (name ?? "").toLowerCase().replace(/[^a-z]/g, "");
/** A table the database doesn't have yet (migration 0059 not run): PostgREST's own words and codes for it. */
export const missingTable = (e: { message?: string; code?: string } | null | undefined) => !!e && /does not exist|Could not find the table|PGRST205|42P01/.test(`${e.message ?? ""} ${e.code ?? ""}`);
const chunks = <T>(xs: readonly T[], size: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size)); return out; };

export interface AgentJob {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  os_client_id: string | null;
  filters: Record<string, unknown>;
  described: string | null;
  mls_scope: string[] | null;
  matched: number | null;
  collected: number;
  status: "collecting" | "adding" | "done" | "failed";
  detail: string | null;
  requested_by: string;
  added: number;
  already: number;
  skipped: number;
  failed: number;
  created_at: string;
  finished_at: string | null;
}

/* ----------------------------------------------------------------------------------- the campaign's client --- */

/** The client a campaign belongs to (its Analytics link, not excluded), as the OS has it — or null. */
export async function campaignClient(campaignId: string | number): Promise<{ osClientId: string; name: string } | null> {
  const { data: link, error } = await getAnalyticsSupabase().from("campaign_clients").select("client_id, excluded").eq("campaign_id", Number(campaignId)).maybeSingle();
  if (error) throw new Error(`campaign_clients: ${error.message}`);
  const l = link as { client_id?: string | null; excluded?: boolean | null } | null;
  if (!l?.client_id || l.excluded) return null;
  const { data: row, error: e2 } = await osTable("os_clients").select("id, name").eq("an_client_id", l.client_id).limit(1);
  if (e2) throw new Error(`os_clients: ${e2.message}`);
  const r = ((row ?? []) as Array<{ id: string; name: string }>)[0];
  return r ? { osClientId: String(r.id), name: String(r.name) } : null;
}

/* ------------------------------------------------------------------------------------ the client's lists --- */

export interface ClientLists {
  emails: Set<string>;
  names: Set<string>;
  domains: Set<string>;
}

/**
 * The client's own lists across its portals — My Agents, the DNC List (people, companies by domain, and the addresses
 * kept for Market's DNC moves), its pipeline: an agent on any of them is never put in its campaign from here, as the
 * portal's Market never moves one (portal-save.ts: by email, by name where an entry has none, by company domain).
 */
export async function loadClientLists(osClientId: string): Promise<ClientLists> {
  // Every portal that is this client's — linked, routed, or its name / alias (usage-billing's portalsOf, the standard).
  const portals = await portalsOf(osClientId);
  const mi = createAdminSupabase();
  type Q = { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
  const all = <T,>(table: string, columns: string, portal: string, key = "client_id") =>
    fetchAllRows<T>(({ from, to }) => (mi.from(table).select(columns).eq(key, portal).order("id") as unknown as Q).range(from, to) as never);
  const out: ClientLists = { emails: new Set(), names: new Set(), domains: new Set() };
  for (const p of portals) {
    const [mine, dnc, pipeline] = await Promise.all([
      all<{ name: string | null; email: string | null }>("client_agents", "id, name, email", p),
      all<{ kind: string; name: string | null; email: string | null; domain: string | null }>("client_dnc_entries", "id, kind, name, email, domain", p),
      all<{ lead_name: string | null; lead_email: string | null }>("client_pipeline_entries", "id, lead_name, lead_email", p),
    ]);
    const people = [...mine, ...dnc.filter((d) => d.kind === "agent"), ...pipeline.map((x) => ({ name: x.lead_name, email: x.lead_email }))];
    for (const x of people) {
      if (lower(x.email)) out.emails.add(lower(x.email));
      else if (personKey(x.name).length >= 5) out.names.add(personKey(x.name));
    }
    for (const d of dnc.filter((x) => x.kind === "company")) { const dom = lower(d.domain).replace(/^@/, ""); if (dom) out.domains.add(dom); }
    const { data: hidden, error } = await mi.from("os_market_dnc_emails").select("email").eq("client_id", p);
    if (error && !missingTable(error)) throw new Error(`os_market_dnc_emails: ${error.message}`);
    for (const h of (hidden ?? []) as Array<{ email: string }>) if (lower(h.email)) out.emails.add(lower(h.email));
  }
  return out;
}

/** Which list an agent is on, or null: by either of its addresses, its addresses' domain, or its name (entries with no email). */
export function onClientList(a: Pick<SyncAgent, "preferred_email" | "enriched_email" | "full_name">, lists: ClientLists): string | null {
  // Its addresses, and the one its lead would be made with (databaseEmail: it can be a source's own).
  const sent = (() => { try { const e = databaseEmail(a as LeadAgent); return "email" in e ? e.email : null; } catch { return null; } })();
  const emails = [...new Set([a.preferred_email, a.enriched_email, sent].map((e) => lower(e as string | null)).filter(Boolean))];
  if (emails.some((e) => lists.emails.has(e))) return "is on the client's DNC List, My Agents or pipeline";
  if (emails.some((e) => lists.domains.has(e.split("@")[1] ?? ""))) return "is at a company on the client's DNC List";
  if (personKey(a.full_name).length >= 5 && lists.names.has(personKey(a.full_name))) return "has the name of someone on the client's DNC List, My Agents or pipeline";
  return null;
}

/* ------------------------------------------------------------------------------------------ the job's sink --- */

type ItemRow = QueueRow;
const iso = (t: number) => new Date(t).toISOString();

/** addInto's outcomes written to the job's items (claimed with this run's token). */
class JobSink implements AddSink {
  names = new Map<string, string>();
  autoWhy = new Map<number, string>();
  readonly token: string;
  readonly now: Date;
  constructor(token: string, now: Date) { this.token = token; this.now = now; }
  private async set(ids: readonly number[], patch: Record<string, unknown>) {
    for (const part of chunks([...ids], 200)) {
      const { error } = await osTable("os_campaign_agent_job_items").update({ ...patch, updated_at: this.now.toISOString() }).in("id", part).eq("claim_token", this.token);
      if (error) throw new Error(`os_campaign_agent_job_items: ${error.message}`);
    }
  }
  async finish(rows: readonly ItemRow[], status: "done" | "skipped" | "failed", detail: string, extra: Record<string, unknown> = {}, outcome?: CampaignOutcome) {
    if (!rows.length) return;
    const kind = outcome?.kind === "added" ? "added" : outcome?.kind === "already" ? "already" : status === "failed" ? "failed" : "skipped";
    await this.set(rows.map((r) => r.id), {
      status, kind, detail: detail.slice(0, 1000), processed_at: this.now.toISOString(), claim_token: null, claimed_at: null, next_try_at: null,
      ...(typeof extra.email === "string" ? { email: extra.email } : {}), ...(extra.eb_lead_id ? { eb_lead_id: String(extra.eb_lead_id) } : {}),
    });
  }
  async retry(rows: readonly ItemRow[], detail: string) {
    const byAttempt = new Map<number, ItemRow[]>();
    for (const r of rows) byAttempt.set(r.attempts, [...(byAttempt.get(r.attempts) ?? []), r]);
    for (const [attempts, group] of byAttempt) {
      const next = attempts + 1;
      if (next >= MAX_ATTEMPTS) { await this.finish(group, "failed", `${detail} (gave up after ${next} tries)`); continue; }
      await this.set(group.map((r) => r.id), { status: "pending", detail: detail.slice(0, 1000), claim_token: null, claimed_at: null, attempts: next, next_try_at: iso(this.now.getTime() + BACKOFF_MIN[attempts] * 60_000) });
    }
  }
  /** Held by another campaign's sequence: for a one-off add, said and left out (a client's Prospects retries weekly instead). */
  async nextWeek(row: ItemRow, detail: string, extra: Record<string, unknown>) {
    await this.finish([row], "skipped", detail.replace(/\s*Trying again every week\.?$/, ""), extra, { kind: "notAdded", reason: "in another campaign's sequence" });
  }
}

/* -------------------------------------------------------------------------------------------- the deps --- */

export interface JobDeps {
  now?: () => Date;
  campaignStatus?: (campaignId: string) => Promise<string | null>;
  ids?: (filters: Record<string, unknown>, offset: number) => Promise<string[]>;
  loadAgents?: (ids: readonly string[], mlsScope: readonly string[] | null) => Promise<Map<string, SyncAgent>>;
  clientLists?: (osClientId: string) => Promise<ClientLists>;
  clientCampaigns?: (osClientId: string) => Promise<Campaign[]>;
  /** The campaign's client as it is NOW (it can be tied to one after the job started). */
  campaignClient?: (campaignId: string) => Promise<{ osClientId: string; name: string } | null>;
  /** prospect-sync's own EmailBison calls, with overrides (the tests' stand-ins); attach is always named for the person who asked. */
  syncBase?: Parameters<typeof prospectSyncDeps>[0];
  bell?: (row: { kind: string; severity: string; title: string; body: string; ref: string }) => Promise<void>;
}

function realDeps(d: JobDeps) {
  const base = prospectSyncDeps();
  return {
    now: d.now ?? (() => new Date()),
    campaignStatus: d.campaignStatus ?? (async (id: string) => {
      try {
        return String((await createEmailBisonClient().getCampaign(Number(id))).status ?? "").toLowerCase() || null;
      } catch (e) {
        if (/404|not found/i.test(e instanceof Error ? e.message : String(e))) return "deleted";
        throw e;
      }
    }),
    ids: d.ids ?? ((filters: Record<string, unknown>, offset: number) => agentIdsPage(filters, offset)),
    loadAgents: d.loadAgents ?? ((ids: readonly string[], mlsScope: readonly string[] | null) => loadLeadAgents(ids, { mlsScope })),
    clientLists: d.clientLists ?? loadClientLists,
    campaignClient: d.campaignClient ?? campaignClient,
    clientCampaigns: d.clientCampaigns ?? (async (osClientId: string) => {
      const record = await base.clientRecord(osClientId);
      return record ? base.campaigns(record) : [];
    }),
    sync: (requestedBy: string): ProspectSyncDeps => prospectSyncDeps({ ...(d.syncBase ?? {}), attach: (campaignId: number, leadIds: number[]) => attachLeads(campaignId, leadIds, `${requestedBy} via Claude`, analyticsTeamId()) }),
    bell: d.bell ?? (async (row: { kind: string; severity: string; title: string; body: string; ref: string }) => {
      const { error } = await osTable("os_notifications").upsert(row, { onConflict: "ref", ignoreDuplicates: true });
      if (error) console.error(JSON.stringify({ tag: "[campaign-agents] bell not saved", ref: row.ref, error: error.message }));
    }),
  };
}

/* ------------------------------------------------------------------------------------------------ the run --- */

export interface JobRunResult { jobs: number; collected: number; claimed: number; finished: string[]; notes: string[] }

/** Updates the job — `running`: only while it is still collecting or adding (a job stopped meanwhile keeps its words). */
async function patchJob(id: string, patch: Record<string, unknown>, now: Date, running = false) {
  let q = osTable("os_campaign_agent_jobs").update({ ...patch, updated_at: now.toISOString() }).eq("id", id);
  if (running) q = q.in("status", ["collecting", "adding"]);
  const { error } = await q;
  if (error) throw new Error(`os_campaign_agent_jobs: ${error.message}`);
}

async function countItems(jobId: string, filter: (q: never) => never): Promise<number> {
  const q = osTable("os_campaign_agent_job_items").select("id", { count: "exact", head: true }).eq("job_id", jobId);
  const { count, error } = await (filter(q as never) as unknown as PromiseLike<{ count: number | null; error: { message: string } | null }>);
  if (error) throw new Error(`os_campaign_agent_job_items: ${error.message}`);
  return count ?? 0;
}

/** The job's totals, from its items. */
export async function jobTotals(jobId: string): Promise<{ added: number; already: number; skipped: number; failed: number; open: number }> {
  const by = (kind: string) => countItems(jobId, ((q: { eq: (c: string, v: string) => unknown }) => q.eq("kind", kind)) as never);
  const [added, already, skipped, failed, open] = await Promise.all([
    by("added"), by("already"), by("skipped"), by("failed"),
    countItems(jobId, ((q: { in: (c: string, v: string[]) => unknown }) => q.in("status", ["pending", "working"])) as never),
  ]);
  return { added, already, skipped, failed, open };
}

export async function runCampaignAgentJobs(d: JobDeps = {}): Promise<JobRunResult> {
  const x = realDeps(d);
  const now = x.now();
  const out: JobRunResult = { jobs: 0, collected: 0, claimed: 0, finished: [], notes: [] };

  // A claim whose run died: back in the queue.
  const stale = await osTable("os_campaign_agent_job_items").update({ status: "pending", claim_token: null, claimed_at: null, updated_at: now.toISOString() })
    .eq("status", "working").lt("claimed_at", iso(now.getTime() - STALE_MS));
  if (stale.error) throw new Error(`os_campaign_agent_job_items: ${stale.error.message}`);

  const { data: jobsData, error } = await osTable("os_campaign_agent_jobs").select("*").in("status", ["collecting", "adding"]).order("created_at", { ascending: true }).limit(JOBS_PER_RUN);
  if (error) throw new Error(`os_campaign_agent_jobs: ${error.message}`);
  for (const job of (jobsData ?? []) as AgentJob[]) {
    out.jobs++;
    try {
      await runJob(x, job, now, out);
    } catch (e) {
      out.notes.push(`${job.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

async function runJob(x: ReturnType<typeof realDeps>, job: AgentJob, now: Date, out: JobRunResult): Promise<void> {
  const name = job.campaign_name ?? `#${job.campaign_id}`;
  // The campaign must still be able to take leads; finished or gone, the job stops.
  const status = await x.campaignStatus(job.campaign_id);
  if (!status || !isOpenStatus(status)) {
    await patchJob(job.id, { status: "failed", detail: `${name} is ${status ?? "unreadable"} now, so no more agents are added to it.`, finished_at: now.toISOString() }, now);
    await x.bell({ kind: "campaign_agents", severity: "warning", title: `Adding agents stopped — ${name}`, body: `${name} is ${status ?? "unreadable"} now; ${job.collected.toLocaleString("en-US")} agents were collected for it (${job.requested_by} via Claude).`, ref: `campaign_agents:stopped:${job.id}` });
    out.finished.push(job.id);
    return;
  }

  if (job.status === "collecting") {
    let page: string[];
    try {
      page = await x.ids(job.filters, job.collected);
    } catch (e) {
      // Counted in the job's own words; the fifth failure in a row stops it (and the bell says so).
      const tries = Number(/Collecting failed (\d+) of 5/.exec(job.detail ?? "")?.[1] ?? 0) + 1;
      const why = e instanceof Error ? e.message : String(e);
      if (tries >= 5) {
        await patchJob(job.id, { status: "failed", detail: `Collecting the agents failed 5 times (${why.slice(0, 300)}); ${job.collected.toLocaleString("en-US")} were collected and are not added. Add them again with narrower filters.`, finished_at: now.toISOString() }, now, true);
        await x.bell({ kind: "campaign_agents", severity: "warning", title: `Adding agents stopped — ${name}`, body: `The agent database couldn't give the agents (${why.slice(0, 200)}) (${job.requested_by} via Claude).`, ref: `campaign_agents:collect-failed:${job.id}` });
        out.finished.push(job.id);
      } else {
        await patchJob(job.id, { detail: `Collecting failed ${tries} of 5 times so far (${why.slice(0, 300)}); trying again next minute.` }, now, true);
      }
      return;
    }
    for (const part of chunks(page, 1000)) {
      const { error } = await osTable("os_campaign_agent_job_items").upsert(part.map((agent_id) => ({ job_id: job.id, agent_id })), { onConflict: "job_id,agent_id", ignoreDuplicates: true });
      if (error) throw new Error(`os_campaign_agent_job_items: ${error.message}`);
    }
    const collected = job.collected + page.length;
    out.collected += page.length;
    const done = page.length < IDS_PAGE;
    if (done && collected === 0) {
      await patchJob(job.id, { collected, status: "done", detail: "No agent matches these filters now.", finished_at: now.toISOString() }, now, true);
      out.finished.push(job.id);
      return;
    }
    await patchJob(job.id, { collected, status: done ? "adding" : "collecting", detail: done ? `${collected.toLocaleString("en-US")} agents to add.` : `Collecting: ${collected.toLocaleString("en-US")} so far.` }, now, true);
    return;
  }

  // ADDING: this run's share of the due items, claimed first.
  const due = `next_try_at.is.null,next_try_at.lte.${now.toISOString()}`;
  const { data: dueRows, error } = await osTable("os_campaign_agent_job_items").select("id, agent_id, attempts").eq("job_id", job.id).eq("status", "pending").or(due).order("id", { ascending: true }).limit(PER_RUN);
  if (error) throw new Error(`os_campaign_agent_job_items: ${error.message}`);
  const pending = (dueRows ?? []) as Array<{ id: number; agent_id: string; attempts: number }>;
  if (!pending.length) {
    const t = await jobTotals(job.id);
    if (t.open === 0) {
      await patchJob(job.id, { status: "done", added: t.added, already: t.already, skipped: t.skipped, failed: t.failed, detail: summary(t), finished_at: now.toISOString() }, now, true);
      await x.bell({ kind: "campaign_agents", severity: t.failed ? "warning" : "info", title: `Agents added — ${name}`, body: `${summary(t)} (${job.requested_by} via Claude).`, ref: `campaign_agents:done:${job.id}` });
      out.finished.push(job.id);
    }
    return;
  }
  const token = randomUUID();
  const claimedIds: number[] = [];
  for (const part of chunks(pending.map((p) => p.id), 200)) {
    const { data: got, error: cErr } = await osTable("os_campaign_agent_job_items").update({ status: "working", claim_token: token, claimed_at: new Date().toISOString(), updated_at: now.toISOString() })
      .in("id", part).eq("status", "pending").select("id");
    if (cErr) throw new Error(`os_campaign_agent_job_items: ${cErr.message}`);
    for (const g of (got ?? []) as Array<{ id: number }>) claimedIds.push(Number(g.id));
  }
  const claimed = pending.filter((p) => claimedIds.includes(p.id));
  out.claimed += claimed.length;
  if (!claimed.length) return;
  const sink = new JobSink(token, now);
  const rows = claimed.map((p) => ({ id: Number(p.id), agent_id: String(p.agent_id), attempts: n(p.attempts), email: null } as unknown as QueueRow));
  try {
    const agents = await x.loadAgents(rows.map((r) => r.agent_id), job.mls_scope && job.mls_scope.length ? job.mls_scope : null);

    // A client's campaign — as it is now (tied to a client after the job started counts): its own lists are never
    // emailed from here; its other campaigns aren't added to twice.
    const now_client = await x.campaignClient(job.campaign_id);
    const osClientId = now_client?.osClientId ?? job.os_client_id;
    if (osClientId && osClientId !== job.os_client_id) await patchJob(job.id, { os_client_id: osClientId }, now, true);
    let own: Campaign[] = [];
    let toAdd = rows;
    if (osClientId) {
      const [lists, campaigns] = await Promise.all([x.clientLists(osClientId), x.clientCampaigns(osClientId)]);
      own = campaigns;
      const left: QueueRow[] = [];
      toAdd = [];
      for (const r of rows) {
        const a = agents.get(r.agent_id);
        const why = a ? onClientList(a, lists) : null;
        if (why) { left.push(r); if (a?.full_name) sink.names.set(r.agent_id, a.full_name); } else toAdd.push(r);
      }
      for (const r of left) {
        const a = agents.get(r.agent_id)!;
        await sink.finish([r], "skipped", `Not added: this agent ${onClientList(a, lists)}.`, {}, { kind: "notAdded", reason: "on the client's own lists" });
      }
    }
    if (toAdd.length) await addInto(x.sync(job.requested_by), { id: String(job.campaign_id), name }, agents, toAdd, own, new Set(), sink);
  } catch (e) {
    // Anything that failed part-way: the agents still claimed by this run are tried again later, each try counted
    // (sink.retry; finished ones keep what they are — only rows still holding this run's claim are touched).
    await sink.retry(rows, `Not added yet: ${e instanceof Error ? e.message : String(e)}`.slice(0, 900));
    out.notes.push(`${job.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const t = await jobTotals(job.id);
  await patchJob(job.id, { added: t.added, already: t.already, skipped: t.skipped, failed: t.failed, detail: `${summary(t)}${t.open ? ` ${t.open.toLocaleString("en-US")} still to go.` : ""}` }, now, true);
}

function summary(t: { added: number; already: number; skipped: number; failed: number }): string {
  const f = (v: number) => v.toLocaleString("en-US");
  return `Added ${f(t.added)}; already in it ${f(t.already)}; not added ${f(t.skipped)}${t.failed ? `; failed ${f(t.failed)}` : ""}.`;
}

/* ---------------------------------------------------------------------------------------- jobs, read and made --- */

/** A new job (status collecting): the run collects its agents from the next minute. */
export async function createAgentJob(o: {
  campaignId: string; campaignName: string; osClientId: string | null; filters: Record<string, unknown>; described: string; mlsScope: string[] | null; matched: number; requestedBy: string;
}): Promise<{ id: string }> {
  const { data, error } = await osTable("os_campaign_agent_jobs").insert({
    campaign_id: o.campaignId, campaign_name: o.campaignName, os_client_id: o.osClientId, filters: o.filters, described: o.described,
    mls_scope: o.mlsScope, matched: o.matched, requested_by: o.requestedBy, status: "collecting",
  }).select("id").single();
  if (error) throw new Error(missingTable(error) ? "needs migrations/0059_campaign_agent_jobs.sql" : `os_campaign_agent_jobs: ${error.message}`);
  return { id: String((data as { id: string }).id) };
}

/** Stops a running job: what is done stays done; the agents not yet worked on are not added. */
export async function stopAgentJob(jobId: string, by: string): Promise<{ stopped: boolean; notAdded: number }> {
  const now = new Date().toISOString();
  const { data, error } = await osTable("os_campaign_agent_jobs").update({ status: "failed", detail: `Stopped by ${by} via Claude.`, finished_at: now, updated_at: now })
    .eq("id", jobId).in("status", ["collecting", "adding"]).select("id");
  if (error) throw new Error(`os_campaign_agent_jobs: ${error.message}`);
  if (!((data ?? []) as unknown[]).length) return { stopped: false, notAdded: 0 };
  const { data: left, error: e2 } = await osTable("os_campaign_agent_job_items").update({ status: "skipped", kind: "skipped", detail: `Not added: the add was stopped by ${by} via Claude.`, processed_at: now, updated_at: now, next_try_at: null })
    .eq("job_id", jobId).eq("status", "pending").select("id");
  if (e2) throw new Error(`os_campaign_agent_job_items: ${e2.message}`);
  const t = await jobTotals(jobId);
  await osTable("os_campaign_agent_jobs").update({ added: t.added, already: t.already, skipped: t.skipped, failed: t.failed, detail: `Stopped by ${by} via Claude. ${summary(t)}` }).eq("id", jobId);
  return { stopped: true, notAdded: ((left ?? []) as unknown[]).length };
}

/** A job still running for this campaign, or null. */
export async function runningJobFor(campaignId: string): Promise<AgentJob | null> {
  const { data, error } = await osTable("os_campaign_agent_jobs").select("*").eq("campaign_id", campaignId).in("status", ["collecting", "adding"]).limit(1);
  if (error) throw new Error(missingTable(error) ? "needs migrations/0059_campaign_agent_jobs.sql" : `os_campaign_agent_jobs: ${error.message}`);
  return ((data ?? []) as AgentJob[])[0] ?? null;
}

/** Recent jobs (or one), with their progress and the commonest reasons agents were not added. */
export async function agentJobsOverview(o: { id?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
  let q = osTable("os_campaign_agent_jobs").select("*").order("created_at", { ascending: false }).limit(Math.min(Math.max(o.limit ?? 10, 1), 25));
  if (o.id) q = osTable("os_campaign_agent_jobs").select("*").eq("id", o.id).limit(1);
  const { data, error } = await q;
  if (error) return { note: missingTable(error) ? "Adding agents isn't set up yet (migration 0059)." : `Jobs could not be read: ${error.message}` };
  const jobs = (data ?? []) as AgentJob[];
  const out = [];
  for (const j of jobs) {
    const open = j.status === "adding" ? (await jobTotals(j.id)).open : null;
    let reasons: Array<{ reason: string; agents: number }> | undefined;
    if (o.id && j.skipped + j.failed > 0) {
      const rows = await fetchAllRows<{ detail: string | null }>(({ from, to }) => osTable("os_campaign_agent_job_items").select("detail").eq("job_id", j.id).in("status", ["skipped", "failed"]).order("id").range(from, to) as never);
      const by = new Map<string, number>();
      for (const r of rows) { const k = (r.detail ?? "").replace(/\s*\(gave up after \d+ tries\)$/, "").slice(0, 160); by.set(k, (by.get(k) ?? 0) + 1); }
      reasons = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, agents]) => ({ reason, agents }));
    }
    out.push({
      job: j.id, campaign: j.campaign_name, campaignNumber: j.campaign_id, status: j.status, filters: j.described, requestedBy: j.requested_by,
      matchedAtPreview: j.matched, collected: j.collected, added: j.added, alreadyInIt: j.already, notAdded: j.skipped, failed: j.failed,
      ...(open !== null ? { stillToGo: open } : {}), detail: j.detail, started: j.created_at, finished: j.finished_at, ...(reasons ? { whyNotAdded: reasons } : {}),
    });
  }
  return { jobs: out, note: out.length ? undefined : "No agents have been added through Claude yet." };
}
