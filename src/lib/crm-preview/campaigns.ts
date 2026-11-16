import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { campaignsOfClient } from "@/lib/clients/pause-campaigns";
import { postToPortalChannel } from "@/lib/clients/prospect-sync/queue";
import { publicOrigin } from "@/lib/mcp/oauth";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { portalBillingHold } from "@/lib/tools/master-inbox/portals/billing-hold";
import { CLIENT_PORTALS_ENABLED } from "@/lib/tools/master-inbox/portals/flag";

import { applyPlan, copyModel, planCopySave, type CopyModel, type CopyProblem, type LiveStep, type SaveInput, type StepWrite } from "./campaign-copy";
import { DEMO_PORTAL_ID, isDemoPortal } from "./demo";
import { marketContext } from "./market";

/*
 * The portal's Campaigns page (17 Nov 2026): a client's campaigns, and their emails, which the client edits (rules and
 * plan: campaign-copy.ts).
 *
 * WHOSE CAMPAIGNS. The client's own EmailBison campaigns, as the prospect sync reads them (prospect-sync/run.ts): the
 * campaigns mapped to the client (campaignsOfClient, strict — a mapping somebody excluded or left ambiguous is not
 * theirs) and the ones made for them at setup; for a client with several portals, only the campaigns routed to this
 * one. Archived and deleted ones aren't shown. Every read and every save checks the campaign is one of these again.
 *
 * A SAVE on a real portal goes to EmailBison straight away (verified on a running campaign, 17 Nov): removals first —
 * a refused one stops everything, with nothing changed — then the changed steps, then the new ones. The sequence is
 * read again afterwards and returned, so the page shows what EmailBison now holds. Every save is written to the
 * campaign's history (Analytics campaign_audit_log, with the steps as they were) and posted to #portal-update.
 *
 * THE DEMO PORTAL has no EmailBison campaigns: its sample campaigns live in os_demo_campaigns (migration 0052), made
 * the first time its page opens. The same rules and plan apply; nothing goes to EmailBison or Slack.
 *
 * ON FOR WHOM. The Demo Portal always; a real portal only while OS_PORTAL_CAMPAIGNS says so ("all", or portal ids,
 * comma separated) — until then it keeps the "Coming soon" page (the user, 17 Nov: "build in demo portal first").
 */

export type CampaignState = "sending" | "paused" | "draft" | "finished";

export interface CampaignSummary {
  id: string;
  name: string;
  state: CampaignState;
}

export interface CampaignView extends CopyModel {
  id: string;
  name: string;
  state: CampaignState;
  /** Its emails can be changed (it isn't finished). Whether this viewer may save is the page's to say. */
  editable: boolean;
  /** Why not, when not. */
  note: string | null;
}

/** `code`: what kind of refusal, for the page — "stale" (changed meanwhile: Reload), "finished", "locked". */
export type CampaignResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; code?: "stale" | "finished" | "locked"; problems?: CopyProblem[]; view?: CampaignView };

const env = () => process.env;

/** Whether this portal's Campaigns page is the real one (else "Coming soon"). */
export function campaignsOn(portalId: string, e: Record<string, string | undefined> = env()): boolean {
  if (isDemoPortal(portalId)) return true;
  const v = (e.OS_PORTAL_CAMPAIGNS ?? "").trim();
  if (!v) return false;
  if (v === "all" || v === "1") return true;
  return v.split(",").map((s) => s.trim()).filter(Boolean).includes(portalId);
}

/** EmailBison's status, as the page says it. Null: not shown (archived, being deleted, anything unknown). */
export function stateOf(status: string | null | undefined): CampaignState | null {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "active" || s === "queued" || s === "launching") return "sending";
  if (s === "paused") return "paused";
  if (s === "draft") return "draft";
  if (s === "completed" || s === "stopped") return "finished";
  return null;
}

const FINISHED_NOTE = "This campaign has finished: there's nothing left to send, so its emails can't be changed.";

const ORDER: Record<CampaignState, number> = { sending: 0, paused: 1, draft: 2, finished: 3 };

/* --------------------------------------------------------------------------------------------- dependencies --- */

export interface DemoRow {
  campaign_id: string;
  name: string;
  status: string;
  steps: LiveStep[];
  sent: Record<string, number>;
  updated_at: string;
}

export interface CampaignDeps {
  /** The client's own campaigns for this portal (any status); null: no client record; undefined: no such portal. */
  ownCampaigns(portalId: string): Promise<Array<{ id: string; name: string; status: string }> | null | undefined>;
  liveCampaign(id: number): Promise<{ name: string; status: string }>;
  liveSequence(id: number): Promise<{ sequenceId: number | null; steps: LiveStep[] }>;
  sentPerStep(id: number): Promise<Map<number, number>>;
  deleteStep(stepId: number): Promise<void>;
  updateSteps(sequenceId: number, title: string, steps: StepWrite[]): Promise<void>;
  addSteps(campaignId: number, title: string, steps: StepWrite[]): Promise<void>;
  audit(row: AuditRow): Promise<void>;
  slack(text: string): Promise<unknown>;
  demoRows(portalId: string): Promise<DemoRow[]>;
  /** Writes a Demo campaign's steps if it is still as read (`updatedAt`); false when it changed meanwhile. */
  demoWrite(portalId: string, campaignId: string, steps: LiveStep[], updatedAt: string, who: string): Promise<boolean>;
  osOrigin(): string;
  /** The client's name, for the #portal-update post. */
  clientName(portalId: string): Promise<string>;
}

export interface AuditRow {
  campaignId: number;
  campaignName: string;
  who: string;
  portalId: string;
  ok: boolean;
  error: string | null;
  before: LiveStep[];
  summary: string[];
  applied: { deleted: number; updated: number; added: number };
}

/* ----------------------------------------------------------------------------------------------------- reads --- */

export async function listCampaigns(portalId: string, deps: CampaignDeps = realDeps()): Promise<CampaignResult<CampaignSummary[]>> {
  if (isDemoPortal(portalId)) {
    const rows = await deps.demoRows(portalId);
    return { ok: true, value: sortSummaries(rows.flatMap((r) => summary(r.campaign_id, r.name, r.status))) };
  }
  const own = await deps.ownCampaigns(portalId);
  if (own === undefined) return { ok: false, status: 404, error: "No such client portal." };
  if (own === null) return { ok: true, value: [] };
  return { ok: true, value: sortSummaries(own.flatMap((c) => summary(c.id, c.name, c.status))) };
}

function summary(id: string, name: string, status: string): CampaignSummary[] {
  const state = stateOf(status);
  return state ? [{ id, name, state }] : [];
}

const sortSummaries = (list: CampaignSummary[]) => list.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));

/** One campaign, read live, as the editor shows it. */
export async function readCampaign(portalId: string, campaignId: string, deps: CampaignDeps = realDeps()): Promise<CampaignResult<CampaignView>> {
  if (isDemoPortal(portalId)) {
    const row = (await deps.demoRows(portalId)).find((r) => r.campaign_id === campaignId);
    if (!row || !stateOf(row.status)) return { ok: false, status: 404, error: "That campaign isn't one of yours." };
    return { ok: true, value: view(row.campaign_id, row.name, row.status, row.steps, sentMap(row.sent)) };
  }
  const mine = await ownCampaign(portalId, campaignId, deps);
  if (!mine.ok) return mine;
  const id = Number(campaignId);
  const [live, seq, sent] = await Promise.all([deps.liveCampaign(id), deps.liveSequence(id), deps.sentPerStep(id)]);
  if (!stateOf(live.status)) return { ok: false, status: 404, error: "That campaign isn't one of yours." };
  return { ok: true, value: view(campaignId, live.name || mine.value.name, live.status, seq.steps, sent) };
}

function view(id: string, name: string, status: string, steps: LiveStep[], sent: Map<number, number>): CampaignView {
  const state = stateOf(status) as CampaignState;
  const editable = state !== "finished";
  return { id, name, state, editable, note: editable ? null : FINISHED_NOTE, ...copyModel(steps, sent) };
}

const sentMap = (o: Record<string, number> | null | undefined) => new Map(Object.entries(o ?? {}).map(([k, v]) => [Number(k), Number(v) || 0]));

async function ownCampaign(portalId: string, campaignId: string, deps: CampaignDeps): Promise<CampaignResult<{ name: string; status: string }>> {
  if (!/^\d{1,12}$/.test(campaignId)) return { ok: false, status: 404, error: "That campaign isn't one of yours." };
  const own = await deps.ownCampaigns(portalId);
  const hit = own?.find((c) => c.id === campaignId);
  if (!hit || !stateOf(hit.status)) return { ok: false, status: 404, error: "That campaign isn't one of yours." };
  return { ok: true, value: hit };
}

/* ----------------------------------------------------------------------------------------------------- saves --- */

/** One save at a time per campaign (this server is one process): a second waits for the first, then sees its result. */
const locks: Map<string, Promise<unknown>> = ((globalThis as Record<string, unknown>).__portalCampaignLocks ??= new Map()) as Map<string, Promise<unknown>>;

async function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(run);
  locks.set(key, mine);
  try {
    return await mine;
  } finally {
    // Settled: the next save starts at once (one small entry per campaign ever saved here).
    if (locks.get(key) === mine) locks.set(key, Promise.resolve());
  }
}

export interface SaveOutcome {
  view: CampaignView;
  /** What changed, in words; empty when nothing did. */
  summary: string[];
}

export async function saveCampaign(portalId: string, campaignId: string, input: SaveInput, who: string, deps: CampaignDeps = realDeps()): Promise<CampaignResult<SaveOutcome>> {
  return oneAtATime(`${portalId}:${campaignId}`, () => (isDemoPortal(portalId) ? saveDemo(portalId, campaignId, input, who, deps) : saveReal(portalId, campaignId, input, who, deps)));
}

async function saveDemo(portalId: string, campaignId: string, input: SaveInput, who: string, deps: CampaignDeps): Promise<CampaignResult<SaveOutcome>> {
  const row = (await deps.demoRows(portalId)).find((r) => r.campaign_id === campaignId);
  if (!row || !stateOf(row.status)) return { ok: false, status: 404, error: "That campaign isn't one of yours." };
  if (stateOf(row.status) === "finished") return { ok: false, status: 409, code: "finished", error: FINISHED_NOTE };
  const sent = sentMap(row.sent);
  const plan = planCopySave(row.steps, input, sent);
  if (!plan.ok) return { ok: false, status: plan.status, error: plan.error, ...("code" in plan ? { code: plan.code } : {}), ...("problems" in plan ? { problems: plan.problems } : {}) };
  if (!plan.updates.length && !plan.adds.length && !plan.deletes.length) return { ok: true, value: { view: view(row.campaign_id, row.name, row.status, row.steps, sent), summary: [] } };
  let next = Math.max(0, ...row.steps.map((s) => s.id)) + 1;
  const steps = applyPlan(row.steps, plan, () => next++);
  if (!(await deps.demoWrite(portalId, campaignId, steps, row.updated_at, who))) {
    return { ok: false, status: 409, code: "stale", error: "This campaign's emails changed since you opened them. Reload to see the latest, then make your changes again." };
  }
  return { ok: true, value: { view: view(row.campaign_id, row.name, row.status, steps, sent), summary: plan.summary } };
}

async function saveReal(portalId: string, campaignId: string, input: SaveInput, who: string, deps: CampaignDeps): Promise<CampaignResult<SaveOutcome>> {
  const mine = await ownCampaign(portalId, campaignId, deps);
  if (!mine.ok) return mine;
  const id = Number(campaignId);
  const [live, seq, sent] = await Promise.all([deps.liveCampaign(id), deps.liveSequence(id), deps.sentPerStep(id)]);
  const state = stateOf(live.status);
  if (!state) return { ok: false, status: 404, error: "That campaign isn't one of yours." };
  if (state === "finished") return { ok: false, status: 409, code: "finished", error: FINISHED_NOTE };
  const name = live.name || mine.value.name;
  const plan = planCopySave(seq.steps, input, sent);
  if (!plan.ok) return { ok: false, status: plan.status, error: plan.error, ...("code" in plan ? { code: plan.code } : {}), ...("problems" in plan ? { problems: plan.problems } : {}) };
  if (!plan.updates.length && !plan.adds.length && !plan.deletes.length) return { ok: true, value: { view: view(campaignId, name, live.status, seq.steps, sent), summary: [] } };
  if (plan.updates.length && !seq.sequenceId) return { ok: false, status: 502, error: "This campaign's emails couldn't be changed just now. Please try again in a minute." };

  const applied = { deleted: 0, updated: 0, added: 0 };
  let failure: string | null = null;
  try {
    // Removals first: EmailBison refuses one that has sent, and then nothing else has changed.
    for (const stepId of plan.deletes) {
      await deps.deleteStep(stepId);
      applied.deleted++;
    }
    // EmailBison renumbers the emails after one it deletes; an email whose number was only to change is sent only if
    // it isn't where it should be now (read again), and `orderOnly` never leaves this process.
    // A version is always written with the number it has right now (never moved).
    let updates = plan.updates;
    if (plan.deletes.length && updates.length) {
      const now = new Map((await deps.liveSequence(id)).steps.map((s) => [s.id, s.order]));
      updates = updates
        .filter((u) => !u.orderOnly || now.get(u.id as number) !== u.order)
        .map((u) => (u.variant && now.get(u.id as number) != null ? { ...u, order: now.get(u.id as number) as number } : u));
    }
    const writes = updates.map(({ orderOnly: _ignored, ...w }) => w);
    if (writes.length) {
      await deps.updateSteps(seq.sequenceId as number, name, writes);
      applied.updated = writes.length;
    }
    if (plan.adds.length) {
      await deps.addSteps(id, name, plan.adds);
      applied.added = plan.adds.length;
    }
  } catch (e) {
    failure = describeEmailBisonError(e);
  }

  // What EmailBison holds now, whatever happened.
  let after: { sequenceId: number | null; steps: LiveStep[] } | null = null;
  try {
    after = await deps.liveSequence(id);
  } catch (e) {
    console.error(JSON.stringify({ at: "[portal-campaigns] re-read failed", campaignId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
  }
  const nothingApplied = applied.deleted + applied.updated + applied.added === 0;
  await deps
    .audit({ campaignId: id, campaignName: name, who, portalId, ok: !failure, error: failure, before: seq.steps, summary: plan.summary, applied })
    .catch((e) => console.error(JSON.stringify({ at: "[portal-campaigns] audit failed", campaignId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) })));
  if (!nothingApplied) {
    await deps.slack(slackText({ client: await deps.clientName(portalId).catch(() => "A client"), campaign: name, campaignId: id, who, summary: plan.summary, failed: failure, origin: deps.osOrigin() })).catch(() => undefined);
  }
  const fresh = after ? view(campaignId, name, live.status, after.steps, sent) : undefined;
  if (failure) {
    // Only when part of it landed does the page get the campaign as it is now (the client's edits otherwise stay).
    console.error(JSON.stringify({ at: "[portal-campaigns] save failed", campaignId, who, applied, error: failure.slice(0, 300) }));
    const removedRefused = /sent|cannot be deleted|can't be deleted/i.test(failure) && applied.deleted < plan.deletes.length;
    return {
      ok: false,
      status: 502,
      error: nothingApplied
        ? removedRefused
          ? "That email has already gone out, so it can't be removed. Nothing was changed."
          : "Your changes couldn't be saved just now. Nothing was changed. Please try again in a minute."
        : "Only part of your change was saved before something went wrong. The emails below are what your campaign has now; check them and save again.",
      ...(fresh && !nothingApplied ? { view: fresh } : {}),
    };
  }
  if (!fresh) return { ok: true, value: { view: view(campaignId, name, live.status, applyPlan(seq.steps, plan, (() => { let n = -1; return () => n--; })()), sent), summary: plan.summary } };
  return { ok: true, value: { view: fresh, summary: plan.summary } };
}

/** A real portal its own save code would refuse right now (page.tsx `locked`, for staff too): why, or null. */
export async function campaignSaveLock(portalId: string): Promise<string | null> {
  if (isDemoPortal(portalId)) return null;
  if (!CLIENT_PORTALS_ENABLED) return "Client portals are switched off, so nothing can be saved.";
  const { data } = await createAdminSupabase().from("clients").select("portal_enabled").eq("id", portalId).maybeSingle();
  if ((data as { portal_enabled?: boolean | null } | null)?.portal_enabled === false) return "This portal is switched off, so nothing can be saved.";
  if (await portalBillingHold(portalId)) return "This portal is paused for an unpaid invoice, so nothing can be saved.";
  return null;
}

/** What the page is told when a read or a save fails outright. */
export function campaignsFailure(err: unknown, kind: "read" | "save"): { status: number; error: string } {
  if (err instanceof DemoTableError && err.missing) return { status: 503, error: "The Demo Portal's sample campaigns aren't set up yet (migration 0052)." };
  return kind === "read"
    ? { status: 502, error: "Your campaigns couldn't be loaded just now. Please try again in a minute." }
    : { status: 502, error: "Your changes couldn't be saved just now. Please try again in a minute." };
}

/** The #portal-update post: who changed which campaign's emails, and what. */
export function slackText(o: { client: string; campaign: string; campaignId: number; who: string; summary: string[]; failed: string | null; origin: string }): string {
  const link = `<${o.origin}/analytics/campaigns/${o.campaignId}|${o.campaign.replace(/[<>|]/g, "")}>`;
  const lines = [`*Emails ${o.failed ? "partly " : ""}changed · ${o.client}*`, link, ...o.summary.map((s) => `• ${s}`)];
  if (o.failed) lines.push(`⚠️ EmailBison stopped part way: ${o.failed.slice(0, 200)}. The rest wasn't saved.`);
  lines.push(`_by ${o.who}, live now_`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------------------------------------ real deps --- */

type EbStep = { id: number; order: number | string | null; email_subject: string | null; email_body: string | null; wait_in_days: number | null; variant: boolean | null; variant_from_step_id: number | null; thread_reply: boolean | null; active?: boolean | null };

export function liveStepOf(s: EbStep): LiveStep {
  const order = s.order === null || s.order === undefined || s.order === "" ? null : Number(s.order);
  return {
    id: Number(s.id),
    order: Number.isFinite(order) ? order : null,
    subject: s.email_subject ?? "",
    body: s.email_body ?? "",
    wait: Number(s.wait_in_days ?? 0) || 0,
    variant: !!s.variant,
    parentId: s.variant && s.variant_from_step_id ? Number(s.variant_from_step_id) : null,
    threadReply: !!s.thread_reply,
    active: s.active !== false,
  };
}

/** The real reads and writes (exported for the live round-trip check against a throwaway campaign). */
export function realDeps(): CampaignDeps {
  const eb = () => createEmailBisonClient();
  return {
    ownCampaigns: portalCampaigns,
    liveCampaign: async (id) => {
      const c = (await eb().getCampaign(id)) as { name?: string; status?: string };
      return { name: String(c.name ?? ""), status: String(c.status ?? "") };
    },
    liveSequence: async (id) => {
      try {
        const r = await eb().getCampaignSequenceSteps(id);
        const d = (r?.data ?? {}) as { sequence_id?: number; sequence_steps?: EbStep[] };
        return { sequenceId: d.sequence_id ?? null, steps: (d.sequence_steps ?? []).map(liveStepOf) };
      } catch (e) {
        // A campaign with no sequence yet answers success:false — an empty sequence, not a fault (sequence route).
        if (/do not exist|not found/i.test(describeEmailBisonError(e))) return { sequenceId: null, steps: [] };
        throw e;
      }
    },
    sentPerStep: async (id) => {
      const out = new Map<number, number>();
      const sb = getAnalyticsSupabase();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("campaign_step_stats_daily").select("sequence_step_id, sent").eq("campaign_id", id).gt("sent", 0).range(from, from + 999);
        if (error) throw new Error(`campaign_step_stats_daily: ${error.message}`);
        for (const r of (data ?? []) as Array<{ sequence_step_id: number; sent: number | null }>) out.set(Number(r.sequence_step_id), (out.get(Number(r.sequence_step_id)) ?? 0) + (r.sent ?? 0));
        if ((data ?? []).length < 1000) break;
      }
      return out;
    },
    deleteStep: async (stepId) => { await eb().deleteSequenceStep(stepId); },
    updateSteps: async (sequenceId, title, steps) => { await eb().updateSequenceSteps(sequenceId, title, steps as unknown as Array<Record<string, unknown>>); },
    addSteps: async (campaignId, title, steps) => { await eb().createSequenceSteps(campaignId, title, steps as unknown as Array<Record<string, unknown>>); },
    audit: async (a) => {
      const { error } = await getAnalyticsSupabase().from("campaign_audit_log").insert({
        team_id: analyticsTeamId(),
        campaign_id: a.campaignId,
        campaign_name: a.campaignName,
        action: "portal-edit-sequence",
        actor: a.who,
        status: a.ok ? "ok" : "error",
        error: a.error,
        before_state: { portal_id: a.portalId, steps: a.before.map((s) => ({ id: s.id, order: s.order, variant: s.variant, variant_from_step_id: s.parentId, thread_reply: s.threadReply, wait_in_days: s.wait, active: s.active, email_subject: s.subject, email_body: s.body })) },
        after_state: { summary: a.summary, applied: a.applied },
      });
      if (error) throw new Error(error.message);
    },
    slack: (text) => postToPortalChannel(text),
    demoRows: demoRows,
    demoWrite: async (portalId, campaignId, steps, updatedAt, who) => {
      const { data, error } = await createAdminSupabase()
        .from("os_demo_campaigns")
        .update({ steps, updated_at: new Date().toISOString(), updated_by: who })
        .eq("portal_id", portalId)
        .eq("campaign_id", campaignId)
        .eq("updated_at", updatedAt)
        .select("campaign_id");
      if (error) throw new Error(`os_demo_campaigns: ${error.message}`);
      return (data ?? []).length === 1;
    },
    osOrigin: () => publicOrigin(),
    clientName: async (portalId) => {
      const ctx = await marketContext(portalId);
      return ctx?.client?.name ?? ctx?.portal.name ?? "A client";
    },
  };
}

/** The client's own EmailBison campaigns for this portal (see the top of this file). */
async function portalCampaigns(portalId: string): Promise<Array<{ id: string; name: string; status: string }> | null | undefined> {
  const ctx = await marketContext(portalId);
  if (!ctx) return undefined;
  if (!ctx.client) return null;
  const osClientId = ctx.client.id;
  const { data: rec, error } = await osTable("os_clients").select("name, aliases, an_client_id").eq("id", osClientId).maybeSingle();
  if (error) throw new Error(`os_clients: ${error.message}`);
  const r = (rec ?? {}) as { name?: string | null; aliases?: string[] | null; an_client_id?: string | null };
  const [strict, setups, routes] = await Promise.all([
    campaignsOfClient({ name: r.name ?? ctx.client.name, aliases: r.aliases ?? [] }, r.an_client_id ? [r.an_client_id] : []),
    osTable("os_setup_campaigns").select("campaign_id, campaign_name, status").eq("os_client_id", osClientId),
    osTable("os_campaign_portals").select("platform, campaign_id, mi_client_id").eq("os_client_id", osClientId),
  ]);
  if (setups.error) throw new Error(`os_setup_campaigns: ${setups.error.message}`);
  if (routes.error) throw new Error(`os_campaign_portals: ${routes.error.message}`);
  const routed = ((routes.data ?? []) as Array<{ platform: string; campaign_id: string; mi_client_id: string }>).filter((x) => x.platform === "emailbison");
  // A client with several portals: only the campaigns routed to this one (prospect-sync's rule).
  const multiPortal = new Set(routed.map((x) => String(x.mi_client_id))).size > 1 || routed.some((x) => String(x.mi_client_id) !== portalId);
  const here = new Set(routed.filter((x) => String(x.mi_client_id) === portalId).map((x) => String(x.campaign_id)));
  const fits = (id: string) => !multiPortal || here.has(id);
  const out = new Map<string, { id: string; name: string; status: string }>();
  for (const c of strict) if (c.platform === "emailbison" && fits(c.id)) out.set(c.id, { id: c.id, name: c.name, status: c.status });
  const made = ((setups.data ?? []) as Array<{ campaign_id: string | null; campaign_name: string | null; status: string }>).filter((s) => s.status === "ready" && s.campaign_id && fits(String(s.campaign_id)) && !out.has(String(s.campaign_id)));
  if (made.length) {
    const { data, error: e2 } = await getAnalyticsSupabase().from("campaigns").select("id, name, status").in("id", made.map((s) => Number(s.campaign_id))).is("deleted_at", null);
    if (e2) throw new Error(`campaigns: ${e2.message}`);
    for (const c of (data ?? []) as Array<{ id: number; name: string | null; status: string | null }>) out.set(String(c.id), { id: String(c.id), name: c.name ?? "", status: String(c.status ?? "") });
  }
  return [...out.values()];
}

/* --------------------------------------------------------------------------------------------- Demo Portal --- */

/** The Demo Portal's campaigns, made from the samples the first time (a row that exists is never overwritten). */
async function demoRows(portalId: string): Promise<DemoRow[]> {
  const db = createAdminSupabase();
  const read = async () => {
    const { data, error } = await db.from("os_demo_campaigns").select("campaign_id, name, status, steps, sent, updated_at").eq("portal_id", portalId).order("campaign_id");
    if (error) throw new DemoTableError(error.message, error.code);
    return (data ?? []) as DemoRow[];
  };
  const rows = await read();
  if (rows.length || portalId !== DEMO_PORTAL_ID) return rows;
  const { error } = await db.from("os_demo_campaigns").upsert(
    DEMO_SAMPLES.map((s) => ({ portal_id: portalId, campaign_id: s.campaign_id, name: s.name, status: s.status, steps: s.steps, sent: s.sent, updated_by: "sample" })),
    { onConflict: "portal_id,campaign_id", ignoreDuplicates: true },
  );
  if (error) throw new DemoTableError(error.message, error.code);
  return read();
}

export class DemoTableError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "DemoTableError";
    this.code = code;
  }
  /** The table isn't there yet (migration 0052 not run). */
  get missing(): boolean {
    return this.code === "PGRST205" || this.code === "42P01";
  }
}

const p = (...paras: string[]) => paras.map((x) => `<p>${x}</p>`).join("");

/** Two sample campaigns, shaped like BrokerStaffer's real ones: choices, a version B, replies in the thread. */
export const DEMO_SAMPLES: Array<Omit<DemoRow, "updated_at">> = [
  {
    campaign_id: "1",
    name: "Demo Portal + Atlanta + Prospects (EST)",
    status: "active",
    steps: [
      { id: 101, order: 1, subject: "{Quick question|Question for you}, {FIRST_NAME}", body: p("{Hi|Hey} {FIRST_NAME},", "Our team is growing and we're looking for two agents who want more business without paying for leads.", "Would you be open to a quick call this week?", "{SENDER_FIRST_NAME}"), wait: 3, variant: false, parentId: null, threadReply: false, active: true },
      { id: 102, order: 2, subject: "Re: {Quick question|Question for you}, {FIRST_NAME}", body: p("Just following up on my note, {FIRST_NAME}.", "Happy to share how our agents get their buyer and seller leads.", "{SENDER_FIRST_NAME}"), wait: 4, variant: false, parentId: null, threadReply: true, active: true },
      { id: 103, order: 3, subject: "Re: {Quick question|Question for you}, {FIRST_NAME}", body: p("Last note from me. If the timing isn't right, no problem at all.", "{SENDER_FULL_NAME}"), wait: 1, variant: false, parentId: null, threadReply: true, active: true },
      { id: 104, order: 4, subject: "{FIRST_NAME}, open to more deals?", body: p("Hi {FIRST_NAME},", "We have more buyer and seller requests than our team can take on, and we'd like to pass some to a great local agent.", "Worth a quick chat?", "{SENDER_FIRST_NAME}"), wait: 1, variant: true, parentId: 101, threadReply: false, active: true },
    ],
    sent: { "101": 214, "104": 198, "102": 96 },
  },
  {
    campaign_id: "2",
    name: "Demo Portal + Team leaders (EST)",
    status: "paused",
    steps: [
      { id: 201, order: 1, subject: "Growing your team, {FIRST_NAME}?", body: p("Hi {FIRST_NAME},", "We help team leaders add agents without spending on recruiting.", "Could I send over a short overview?", "{SENDER_FIRST_NAME}"), wait: 5, variant: false, parentId: null, threadReply: false, active: true },
      { id: 202, order: 2, subject: "Re: Growing your team, {FIRST_NAME}?", body: p("Circling back in case this got buried, {FIRST_NAME}.", "{SENDER_FIRST_NAME}"), wait: 1, variant: false, parentId: null, threadReply: true, active: true },
    ],
    sent: {},
  },
];
