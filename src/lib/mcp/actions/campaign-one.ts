import "server-only";

import { grantsForRequest } from "@/lib/workspace/tool-paths";
import { osTable } from "@/lib/clients/os-db";
import { applyCampaignAction } from "@/lib/tools/analytics/campaigns/actions.ts";
import { launchSummary, launchVerdict, type LaunchFacts } from "@/lib/tools/analytics/campaigns/launch.ts";
import { launchCampaign, launchFacts } from "@/lib/tools/analytics/campaigns/launch-load";
import { planSettings } from "@/lib/tools/analytics/campaigns/settings-rules.ts";
import { applySettings, readSettings } from "@/lib/tools/analytics/campaigns/settings-update.ts";
import { canApply, whyNot } from "@/lib/tools/analytics/campaigns/status.ts";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import type { ToolId } from "@/lib/bs-auth";

import type { ActionSpec } from "./core.ts";

/*
 * ONE CAMPAIGN THROUGH CLAUDE (27 Nov; the user: "almost everything except billing changes", the Campaigns group):
 * pause it, start it (a draft's launch or a paused one's resume), its sending limits. Each runs the Campaign
 * Analytics screen's own code, so the same checks, the same audit log ("<email> via Claude") and the same cache write:
 *   campaign_pause  — the row menu's Pause (campaigns/actions.ts applyCampaignAction)
 *   campaign_start  — the Launch tab (launch-load.ts: its live checks again, then the one call)
 *   campaign_limits — the Settings tab (settings-update.ts: only what changed, the two limits together)
 * EmailBison only: BrokerStaffer stopped using Instantly (19 Nov). A campaign is named by its number or by a name that
 * matches exactly one EmailBison campaign; several matches are listed and nothing is done.
 */

const NEEDS = (path: string, method: string) => (grantsForRequest(path, method) ?? []) as ToolId[];
const actor = (email: string) => `${email} via Claude`;
const n = (v: number) => v.toLocaleString("en-US");
/* How long after a pause its status is read back (the tests set it to 0). */
export let PAUSE_CHECK_MS = 5_000;
export const setPauseCheckMs = (ms: number) => { PAUSE_CHECK_MS = ms; };

export interface EbCampaign { id: number; name: string; status: string }

/** An EmailBison campaign by its number ("1421", "#1421") or a name matching exactly one; otherwise why not. */
export async function resolveEbCampaign(query: string): Promise<EbCampaign | { error: string }> {
  const q = query.trim();
  if (!q) return { error: "Which campaign? Give its name or number." };
  const an = getAnalyticsSupabase();
  const base = () => an.from("campaigns_unified").select("id, name, status").eq("team_id", analyticsTeamId()).eq("platform", "emailbison");
  type Row = { id: string | number; name: string; status: string };
  const one = (r: Row): EbCampaign => ({ id: Number(r.id), name: String(r.name), status: String(r.status).toLowerCase() });
  const list = (rows: Row[]) => rows.map((r) => `${r.name} (#${r.id}, ${r.status})`).join("; ");
  const num = /^#?(\d+)$/.exec(q);
  if (num) {
    const { data, error } = await base().eq("id", num[1]).limit(1);
    if (error) return { error: `Campaigns could not be read: ${error.message}` };
    const rows = (data ?? []) as Row[];
    return rows.length ? one(rows[0]) : { error: `No EmailBison campaign #${num[1]}.` };
  }
  const like = q.replace(/[%_\\]/g, (c) => `\\${c}`);
  const pick = (rows: Row[], how: string): EbCampaign | { error: string } | null => {
    if (rows.length === 1) return one(rows[0]);
    if (rows.length > 1) return { error: `"${q}" ${how} ${rows.length >= 9 ? "many" : rows.length} campaigns: ${list(rows.slice(0, 8))}${rows.length > 8 ? "; …" : ""}. Which one? Give its number.` };
    return null;
  };
  const exact = await base().ilike("name", like).limit(9);
  if (exact.error) return { error: `Campaigns could not be read: ${exact.error.message}` };
  const e = pick((exact.data ?? []) as Row[], "is the name of");
  if (e) return e;
  const contains = await base().ilike("name", `%${like}%`).limit(9);
  const c = pick((contains.data ?? []) as Row[], "matches");
  if (c) return c;
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !["the", "campaign", "campaigns"].includes(w));
  if (words.length > 1) {
    let w = base();
    for (const word of words) w = w.ilike("name", `%${word}%`);
    const r = pick(((await w.limit(9)).data ?? []) as Row[], "matches");
    if (r) return r;
  }
  return { error: `No EmailBison campaign called "${q}".` };
}

/* A client the OS has as paused or churned: said before a campaign of theirs starts (never blocking — the screen doesn't). */
async function clientNote(clientName: string | null): Promise<string> {
  if (!clientName) return "";
  const { data } = await osTable("os_clients").select("name, aliases, status");
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const k = key(clientName);
  const row = ((data ?? []) as Array<{ name: string; aliases: string[] | null; status: string | null }>)
    .find((r) => key(r.name) === k || (r.aliases ?? []).some((a) => key(a) === k));
  if (!row || !row.status || row.status === "active" || row.status === "onboarding") return "";
  return ` Note: ${row.name} is ${row.status} in the OS.`;
}

/* ------------------------------------------------------------------------------------------------- pause --- */

type One = { campaign: string };
const parseOne = (a: Record<string, unknown>): One | { error: string } => {
  const campaign = String(a.campaign ?? "").trim();
  return campaign ? { campaign } : { error: "Which campaign? Give its name or number." };
};

export const campaignPause: ActionSpec<One, { id: number; status: string }> = {
  name: "campaign_pause",
  title: "Pause one campaign",
  description:
    "Pause ONE EmailBison campaign, as Campaign Analytics' Pause does: its emails stop going out until it is started " +
    "again (campaign_start). Name it by its number or its name; the preview shows its live status.",
  inputSchema: { type: "object", properties: { campaign: { type: "string", description: "The campaign's name or number." } }, required: ["campaign"] },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  needs: NEEDS("/api/tools/analytics/campaigns/actions", "POST"),
  parse: parseOne,
  async preview(a) {
    const c = await resolveEbCampaign(a.campaign);
    if ("error" in c) return { ok: false, refusal: c.error };
    // The live status, not the cache's: the cache can be half an hour behind.
    const live = String((await createEmailBisonClient().getCampaign(c.id)).status ?? c.status).toLowerCase();
    if (!canApply("pause", live)) return { ok: false, refusal: `${c.name} (#${c.id}) can't be paused: ${whyNot("pause", live)}.` };
    // Still starting (27 Nov, live test): EmailBison answers "paused" to a pause sent while a start is queued, then
    // finishes the start and the campaign is active again. Refused until it shows active.
    if (live === "queued" || live === "launching") {
      return { ok: false, refusal: `${c.name} (#${c.id}) is still being started by EmailBison (${live}). A pause sent now can be undone when the start finishes, so wait a minute until it shows active, then pause it.` };
    }
    return {
      ok: true,
      preview: `Pause "${c.name}" (#${c.id}, ${live} now). Its emails stop going out until it is started again.`,
      bind: { id: c.id, status: live },
    };
  },
  async execute(_a, v, bind) {
    const { results } = await applyCampaignAction("pause", [{ platform: "emailbison", id: String(bind.id) }], actor(v.email), analyticsTeamId());
    const r = results[0];
    if (!r?.ok) throw new Error(r?.error ?? "EmailBison did not pause it.");
    // Read back a few seconds later: what EmailBison holds then is what is said.
    await new Promise((res) => setTimeout(res, PAUSE_CHECK_MS));
    const now = String((await createEmailBisonClient().getCampaign(bind.id)).status ?? "").toLowerCase();
    console.info(`[mcp-action] ${actor(v.email)}: paused campaign #${bind.id} (EmailBison now: ${now || "unknown"})`);
    if (now && now !== "paused") throw new Error(`EmailBison accepted the pause but now shows the campaign ${now}. Pause it again in a minute, and check it in Campaign Analytics.`);
    return { campaign: r.name, number: bind.id, status: now || r.status || "paused" };
  },
};

/* ------------------------------------------------------------------------------------------------- start --- */

type StartBind = { id: number; status: string; steps: number | null; leads: number | null; inboxes: number | null; unfilled: string[] | null; dailyLimit: number | null };
const factsBind = (id: number, f: LaunchFacts): StartBind => ({ id, status: f.status, steps: f.steps, leads: f.leads, inboxes: f.inboxes, unfilled: f.unfilled, dailyLimit: f.dailyLimit });

export const campaignStart: ActionSpec<One, StartBind> = {
  name: "campaign_start",
  title: "Start one campaign",
  description:
    "Start ONE EmailBison campaign: a draft is launched, a paused one resumed — the Launch tab's own action. Its live " +
    "checks run first (a sequence, no unfilled client fields, leads, inboxes); anything missing is said and nothing is " +
    "started. Starting queues real emails to its leads and cannot be undone, only paused.",
  inputSchema: { type: "object", properties: { campaign: { type: "string", description: "The campaign's name or number." } }, required: ["campaign"] },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  needs: NEEDS("/api/tools/analytics/campaigns/1/launch", "POST"),
  parse: parseOne,
  async preview(a) {
    const c = await resolveEbCampaign(a.campaign);
    if ("error" in c) return { ok: false, refusal: c.error };
    const read = await launchFacts(c.id, analyticsTeamId());
    if (!read) return { ok: false, refusal: `${c.name} (#${c.id}) isn't in Campaign Analytics yet — run Sync campaigns first.` };
    const verdict = launchVerdict(read.facts);
    const checks = verdict.checks.map((k) => `${k.label}: ${k.detail}${k.state === "warn" ? " (check)" : k.state === "blocked" ? " (missing)" : ""}`).join("; ");
    if (!verdict.can || !verdict.action) return { ok: false, refusal: `${read.name} (#${c.id}) can't be started: ${verdict.reason ?? "not ready"} Checks — ${checks}.` };
    return {
      ok: true,
      preview: `${launchSummary(read.facts, verdict.action).replace("this campaign", `"${read.name}" (#${c.id})`)} Checks — ${checks}.${await clientNote(read.facts.clientName)}`,
      details: { action: verdict.action, checks: verdict.checks },
      bind: factsBind(c.id, read.facts),
    };
  },
  async execute(_a, v, bind) {
    const outcome = await launchCampaign(bind.id, actor(v.email), analyticsTeamId());
    if (!outcome.ok) throw new Error(outcome.error ?? "It could not be started.");
    console.info(`[mcp-action] ${actor(v.email)}: started campaign #${bind.id} → ${outcome.status}`);
    return { number: bind.id, status: outcome.status };
  },
};

/* ------------------------------------------------------------------------------------------------ limits --- */

type Limits = { campaign: string; daily_limit?: number; new_leads_per_day?: number };
type LimitsBind = { id: number; before: { max_emails_per_day: unknown; max_new_leads_per_day: unknown }; changed: Record<string, unknown> };
const LIMIT_MAX = 100_000;

export const campaignLimits: ActionSpec<Limits, LimitsBind> = {
  name: "campaign_limits",
  title: "Change one campaign's sending limits",
  description:
    "Change ONE EmailBison campaign's daily send limit (emails a day) and/or new leads per day — the Settings tab's " +
    "own save. The daily send limit must be at least the new leads per day. The preview shows before and after.",
  inputSchema: {
    type: "object",
    properties: {
      campaign: { type: "string", description: "The campaign's name or number." },
      daily_limit: { type: "integer", minimum: 0, maximum: LIMIT_MAX, description: "Emails a day." },
      new_leads_per_day: { type: "integer", minimum: 0, maximum: LIMIT_MAX, description: "New leads started a day." },
    },
    required: ["campaign"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  needs: NEEDS("/api/tools/analytics/campaigns/1/settings", "PATCH"),
  parse(a) {
    const campaign = String(a.campaign ?? "").trim();
    if (!campaign) return { error: "Which campaign? Give its name or number." };
    const num = (v: unknown, what: string): number | undefined | { error: string } => {
      if (v === undefined || v === null || v === "") return undefined;
      const x = Number(v);
      return Number.isInteger(x) && x >= 0 && x <= LIMIT_MAX ? x : { error: `${what} must be a whole number from 0 to ${n(LIMIT_MAX)}.` };
    };
    const d = num(a.daily_limit, "daily_limit");
    const l = num(a.new_leads_per_day, "new_leads_per_day");
    if (typeof d === "object") return d;
    if (typeof l === "object") return l;
    if (d === undefined && l === undefined) return { error: "Give daily_limit and/or new_leads_per_day." };
    return { campaign, ...(d === undefined ? {} : { daily_limit: d }), ...(l === undefined ? {} : { new_leads_per_day: l }) };
  },
  async preview(a) {
    const c = await resolveEbCampaign(a.campaign);
    if ("error" in c) return { ok: false, refusal: c.error };
    const before = await readSettings(c.id, analyticsTeamId());
    if (!before) return { ok: false, refusal: `${c.name} (#${c.id}) isn't in Campaign Analytics yet — run Sync campaigns first.` };
    const patch = { ...(a.daily_limit === undefined ? {} : { max_emails_per_day: a.daily_limit }), ...(a.new_leads_per_day === undefined ? {} : { max_new_leads_per_day: a.new_leads_per_day }) };
    const { changed, conflict } = planSettings(before, patch);
    const asked = Object.keys(patch).filter((k) => k in changed && changed[k] !== before[k]);
    if (!asked.length) return { ok: false, refusal: `${c.name} (#${c.id}) already has those limits.` };
    if (conflict) return { ok: false, refusal: conflict };
    const word = (k: string) => (k === "max_emails_per_day" ? "Daily send limit" : "New leads per day");
    const show = (v: unknown) => (typeof v === "number" ? n(v) : "not set");
    const lines = (["max_emails_per_day", "max_new_leads_per_day"] as const).map((k) =>
      k in patch && changed[k] !== before[k] ? `${word(k)}: ${show(before[k])} → ${show(changed[k])}` : `${word(k)} stays ${show(before[k])}`);
    return {
      ok: true,
      preview: `Sending limits of "${c.name}" (#${c.id}): ${lines.join("; ")}.`,
      bind: { id: c.id, before: { max_emails_per_day: before.max_emails_per_day ?? null, max_new_leads_per_day: before.max_new_leads_per_day ?? null }, changed },
    };
  },
  async execute(_a, v, bind) {
    const team = analyticsTeamId();
    const before = await readSettings(bind.id, team);
    if (!before) throw new Error("The campaign is no longer in Campaign Analytics.");
    const outcome = await applySettings(bind.id, before, bind.changed, actor(v.email), team);
    if (!outcome.ok) throw new Error(outcome.error);
    console.info(`[mcp-action] ${actor(v.email)}: limits of campaign #${bind.id} → ${JSON.stringify(outcome.changed)}`);
    return { number: bind.id, changed: outcome.changed };
  },
};
