import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSending, liveCampaigns, pauseListed, planToggle, resumeListed, sharedWithOthers, type PlannedCampaign } from "@/lib/tools/client-health/campaign-toggle";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";
import { applyLabelToThread } from "@/lib/tools/master-inbox/inbox/apply-label";

import { keysBilledBefore, loadSettings, tellBell, UsageBillingError } from "./billing";
import {
  CAP_RESTART_FROM_HOUR_ET, campaignsFromJson, capActsOn, capAppliesTo, capsHoldLive, capsLive, capWindowOf, columnIsMissing, effectiveCap, isOverCap, mergeCampaigns, parseSpendCap, tableIsMissing,
  type CapCampaign, type CapWindow, type EffectiveCap,
} from "./caps-model.ts";
import { billableLeads, heldLeadsOf, type LeadSourceFn } from "./leads";
import { DEFAULT_LEAD_SOURCE, dedupeLeads, easternDay, easternHour, LEAD_SOURCES_ALL, modeOf, periodLabel, type BillableLead, type LeadSource, type SettingsRow } from "./model.ts";

/*
 * LEAD AND SPEND CAPS (5 Nov 2026; plan approved by Eddy, Slack).
 *
 *   A client billed live per lead has a lead cap (its Monthly introduction target,
 *   Client Health) and, optionally, a spend limit on the Billing tab. Whichever
 *   is reached first applies. A client still in test has neither acting yet: most
 *   targets are goals, and a test row must never pause a real campaign.
 *
 *   At the cap its campaigns pause, and restart at the start of its next 28-day
 *   window. Only campaigns this confirmed it paused restart: one a person paused by
 *   hand stays paused, unless someone on the Billing tab adds it to the restart. A
 *   campaign a person restarted drops off the list. One linked to another client
 *   too is left running, and the team is told.
 *
 *   A reply that still comes in, because of emails already sent, goes to the client
 *   and is billed, as ever. So neither cap is a ceiling on what a client is charged:
 *   they stop the emailing, not what it has already started.
 *
 *   Behind a second switch, off (OS_LEAD_CAPS_HOLD=1; caps-model.ts): such a reply
 *   goes to Keep Warm instead, not sent, no Pipeline entry, not charged, and the team
 *   is told. It waits for a person to send it, and uses the cap and is billed from the
 *   moment it really goes. Pressed but not gone yet, it is checked against the cap again.
 *
 * Off by default: without OS_LEAD_CAPS=1 the run reads, and logs what it would do.
 * Nothing here charges anything. See caps-model.ts for the rules.
 */

type Row = Record<string, unknown>;
type Env = Record<string, string | undefined>;
const ACTOR = "lead cap";
const WINDOWS = "os_cap_windows";
const WINDOW_COLUMNS = "os_client_id, window_start, window_end, reached_at, paused, restarted_at, updated_at";
const say = (s: string) => s.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_m, _y, mo, d) => `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(mo) - 1]} ${Number(d)}`);
const leadsWord = (n: number) => `${n} lead${n === 1 ? "" : "s"}`;
const keyOf = (c: { platform: string; id: string }) => `${c.platform}:${c.id}`;
const repliesWords = (holding: boolean) => (holding ? "Replies that still come in go to Keep Warm, not sent or charged." : "Replies to emails already sent still go to the client, and are billed.");

/* -------------------------------------------------------------- reading --- */

const SETTINGS_FOR_CAPS = "os_client_id, test_only, price_cents, every_days, anchor_date, lead_source, enabled, stripe_customer_id, default_payment_method_id, card_label, setup_session_id";

async function allSettings(): Promise<SettingsRow[]> {
  const { data, error } = await osTable("os_usage_billing_settings").select(SETTINGS_FOR_CAPS);
  if (error) throw new Error(`os_usage_billing_settings: ${error.message}`);
  return (data ?? []) as unknown as SettingsRow[];
}

/*
 * Read on its own, never added to the settings' column list: the live billing run reads that list, and asking it for
 * a column that doesn't exist yet would stop charging. Before migration 0049, nobody has a limit and none can be saved.
 */
async function readSpendCap(osClientId: string): Promise<{ cents: number | null; ready: boolean }> {
  const { data, error } = await osTable("os_usage_billing_settings").select("spend_cap_cents").eq("os_client_id", osClientId).maybeSingle();
  if (error) {
    if (columnIsMissing(error)) return { cents: null, ready: false };
    throw new Error(`os_usage_billing_settings: ${error.message}`);
  }
  const v = (data as Row | null)?.spend_cap_cents;
  return { cents: typeof v === "number" ? v : null, ready: true };
}

interface CapInputs {
  name: string;
  status: string | null;
  chId: string | null;
  eff: EffectiveCap;
  spendReady: boolean;
}

/** Who the client is and what its cap is. A failed read throws: an unknown cap is never "no cap". */
async function capInputs(s: Pick<SettingsRow, "os_client_id" | "price_cents">): Promise<CapInputs> {
  const { data, error } = await osTable("os_clients").select("name, status, ch_client_id").eq("id", s.os_client_id).maybeSingle();
  if (error) throw new Error(`os_clients: ${error.message}`);
  const rec = (data ?? {}) as Row;
  const chId = typeof rec.ch_client_id === "string" && rec.ch_client_id ? rec.ch_client_id : null;
  let monthlyTarget: unknown = null;
  if (chId) {
    const { data: ch, error: chErr } = await getClientHealthDb().from("clients").select("monthly_target").eq("id", chId).maybeSingle();
    if (chErr) throw new Error(`Client Health: ${chErr.message}`);
    // Linked to a row that isn't there is a broken link, not "no target".
    if (!ch) throw new Error("Client Health has no row for this client's link");
    monthlyTarget = (ch as Row).monthly_target ?? null;
  }
  const spend = await readSpendCap(s.os_client_id);
  return {
    name: typeof rec.name === "string" && rec.name ? rec.name : "A client",
    status: typeof rec.status === "string" ? rec.status : null,
    chId,
    eff: effectiveCap({ monthlyTarget, spendCapCents: spend.cents, priceCents: s.price_cents }),
    spendReady: spend.ready,
  };
}

/** The client's leads of a window, exactly as billing counts them: held replies are not among them. */
async function leadsInWindow(s: SettingsRow, w: CapWindow, source?: LeadSourceFn): Promise<BillableLead[]> {
  const leadSource = ((LEAD_SOURCES_ALL as readonly string[]).includes(s.lead_source) ? s.lead_source : DEFAULT_LEAD_SOURCE) as LeadSource;
  const raw = await (source
    ? source(s.os_client_id, w.start, w.end, { startDate: s.anchor_date })
    : billableLeads(s.os_client_id, w.start, w.end, leadSource, { startDate: s.anchor_date }));
  return dedupeLeads(raw, await keysBilledBefore(s.os_client_id, w.start, modeOf(s) === "test")).billable;
}

interface WindowRow {
  os_client_id: string;
  window_start: string;
  window_end: string;
  reached_at: string | null;
  paused: unknown;
  restarted_at: string | null;
  updated_at: string;
}

/** Before migration 0049 there are none, which only matters to a dry run: a live run's first write says so. */
async function windowRows(osClientId: string): Promise<WindowRow[]> {
  const { data, error } = await osTable(WINDOWS).select(WINDOW_COLUMNS).eq("os_client_id", osClientId);
  if (error) {
    if (tableIsMissing(error)) return [];
    throw new Error(`os_cap_windows: ${error.message}`);
  }
  return (data ?? []) as unknown as WindowRow[];
}

/*
 * Every change to a window's row goes through here: read it NOW, work out the change from that, and write only if
 * nobody else has since. Two runs overlap during a deploy, and a person's press can land during a run; a plain
 * upsert from an earlier read would write over the campaigns the other one just listed, and a campaign whose name is
 * lost from the list stays paused for good with nothing to say so.
 */
async function changeWindow(osClientId: string, w: Pick<WindowRow, "window_start" | "window_end">, change: (cur: WindowRow | null) => Row): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await osTable(WINDOWS).select(WINDOW_COLUMNS).eq("os_client_id", osClientId).eq("window_start", w.window_start).maybeSingle();
    if (error) throw new Error(`os_cap_windows: ${error.message}`);
    const cur = (data ?? null) as unknown as WindowRow | null;
    const patch = { ...change(cur), updated_at: new Date().toISOString() };
    const write = cur
      ? await osTable(WINDOWS).update(patch).eq("os_client_id", osClientId).eq("window_start", w.window_start).eq("updated_at", cur.updated_at).select("window_start")
      : await osTable(WINDOWS)
        .upsert({ os_client_id: osClientId, window_start: w.window_start, window_end: w.window_end, ...patch }, { onConflict: "os_client_id,window_start", ignoreDuplicates: true })
        .select("window_start");
    if (write.error) throw new Error(`os_cap_windows: ${write.error.message}`);
    if (((write.data ?? []) as unknown[]).length) return;
  }
  throw new Error("os_cap_windows: it kept changing while this was being written");
}

const windowRowOf = (w: CapWindow) => ({ window_start: w.start, window_end: w.end });
/** What a window's row is still holding: once restarted its list is history, and a person may have paused one since. */
const stillListed = (r: WindowRow | null) => (r && !r.restarted_at ? campaignsFromJson(r.paused) : []);
const asCampaign = (c: PlannedCampaign, at: string, confirmed: boolean): CapCampaign => ({ platform: c.platform, id: c.id, int_id: c.int_id, name: c.name, paused_at: at, confirmed });
const names = (list: ReadonlyArray<{ name: string }>) => list.map((c) => c.name).join(", ");
/** A status that says nothing about whether it is sending: it may be, so it is never taken as stopped. */
const statusUnread = (status: string) => status === "unreachable" || status === "unknown" || status.startsWith("status ");

/* -------------------------------------------------- labels (Keep Warm) --- */

async function labelIdOf(workspaceId: string, name: string): Promise<string | null> {
  const { data, error } = await createAdminSupabase().from("labels").select("id").eq("workspace_id", workspaceId).ilike("name", name).maybeSingle();
  if (error) throw new Error(`labels: ${error.message}`);
  return ((data as Row | null)?.id as string | undefined) ?? null;
}

async function applyNamedLabel(workspaceId: string, threadId: string, name: string): Promise<void> {
  const labelId = await labelIdOf(workspaceId, name);
  if (!labelId) throw new Error(`there is no ${name} label in this workspace`);
  const r = await applyLabelToThread({ supabase: createAdminSupabase(), workspaceId, threadId, labelId, actor: { kind: "agent", agentId: ACTOR } });
  if (!r.ok) throw new Error(r.error);
}

/** The conversation's labels now. Each conversation carries one, and applying another replaces it. */
async function labelNamesOf(threadId: string): Promise<string[]> {
  const sb = createAdminSupabase();
  const { data, error } = await sb.from("label_assignments").select("label_id").eq("target_type", "thread").eq("target_id", threadId);
  if (error) throw new Error(`label_assignments: ${error.message}`);
  const ids = ((data ?? []) as Row[]).map((r) => String(r.label_id));
  if (!ids.length) return [];
  const { data: rows, error: lErr } = await sb.from("labels").select("name").in("id", ids);
  if (lErr) throw new Error(`labels: ${lErr.message}`);
  return ((rows ?? []) as Row[]).map((r) => String(r.name));
}

async function hasPipelineEntry(threadId: string): Promise<boolean> {
  const { data, error } = await createAdminSupabase().from("client_pipeline_entries").select("id").eq("thread_id", threadId).limit(1);
  if (error) throw new Error(`client_pipeline_entries: ${error.message}`);
  return ((data ?? []) as Row[]).length > 0;
}

/**
 * The label is what the team sees. A failure here never sends anything: the run tries again. Only a conversation still
 * marked Interested moves. A person who has since given it another label (Unsubscribe, a meeting) or none has decided,
 * and that is never written over. Nor one with a Pipeline entry: a label swap leaves a conversation with no label for a
 * moment, and the database then deletes its entry, with the client's notes (0033).
 */
async function moveToKeepWarm(osClientId: string, workspaceId: string, threadId: string, now: Date): Promise<"moved" | "left" | "failed"> {
  try {
    const labels = await labelNamesOf(threadId);
    const interestedOnly = labels.length > 0 && labels.every((l) => l.trim().toLowerCase() === "interested");
    const moves = interestedOnly && !(await hasPipelineEntry(threadId));
    if (moves) await applyNamedLabel(workspaceId, threadId, "Keep Warm");
    const { error } = await osTable("os_cap_held_leads").update({ labelled_at: now.toISOString() }).eq("thread_id", threadId);
    if (error) throw new Error(error.message);
    return moves ? "moved" : "left";
  } catch (e) {
    await tellBell({
      kind: "lead_cap_problem", severity: "warning", osClientId, ref: `cap_label:${threadId}:${easternDay(now)}`,
      title: "A reply over the cap couldn't be moved to Keep Warm",
      body: `${(e instanceof Error ? e.message : String(e)).slice(0, 300)} It was not sent or charged. The run tries again.`,
    });
    return "failed";
  }
}

/* -------------------------------------------------- the hand-off's hook --- */

export interface OverCap {
  cap: number;
  used: number;
  window: CapWindow;
}

export interface RelayCapHook {
  /** Is this conversation's reply past its client's cap? Throws when that can't be known: the hand-off then holds. */
  overCap(p: { osClientId: string; threadId: string; at: string; now: Date; pressed: boolean }): Promise<OverCap | null>;
  hold(p: { osClientId: string; clientName: string; relayId: string; threadId: string; agentName: string | null; agentEmail: string | null; over: OverCap; workspaceId: string }): Promise<void>;
  /** Why it can't be sent now, in words, or null when there is room. */
  roomFor(p: { osClientId: string; now: Date }): Promise<string | null>;
  backToInterested(p: { threadId: string; workspaceId: string }): Promise<void>;
  markReleased(p: { threadId: string; who: string; now: Date }): Promise<void>;
}

/** One per sweep: what it reads is kept for that sweep alone, so a run through many replies reads each client once. */
export function relayCapHook(): RelayCapHook {
  const settings = new Map<string, Promise<SettingsRow | null>>();
  const leads = new Map<string, Promise<BillableLead[]>>();
  let tables: Promise<void> | null = null;
  const settingsOf = (id: string) => {
    if (!settings.has(id)) settings.set(id, loadSettings(id));
    return settings.get(id)!;
  };
  // Switched on before the SQL has run: billing's reader takes a missing table for "none held", which here would read as "nothing to hold".
  const tablesReady = () => {
    tables ??= (async () => {
      const { error } = await osTable("os_cap_held_leads").select("thread_id").limit(1);
      if (error) throw new Error(tableIsMissing(error) ? "lead caps are on, but database migration 0049 hasn't been run" : `os_cap_held_leads: ${error.message}`);
    })();
    return tables;
  };
  return {
    async overCap({ osClientId, threadId, at, now, pressed }) {
      const s = await settingsOf(osClientId);
      if (!s || !capAppliesTo(s)) return null; // Not billed live per lead: no cap, and nothing more to read.
      await tablesReady();
      const held = (await heldLeadsOf(osClientId)).find((h) => h.thread_id === threadId);
      if (held?.released_at && pressed) return null; // The press itself has just been told there is room.
      const { eff, status } = await capInputs(s);
      const leadsOf = (w: CapWindow) => {
        const key = `${osClientId}:${w.start}`;
        if (!leads.has(key)) leads.set(key, leadsInWindow(s, w));
        return leads.get(key)!;
      };
      // Pressed, and it didn't go then (the hourly limit, a read error, no contact yet). It isn't a lead until it goes, so
      // it can't run past a cap that has filled up since, perhaps in a later window: it goes back to waiting.
      // Read fresh, not the sweep's copy: one released just before this in the same sweep has gone, and now counts.
      if (held?.released_at) {
        const w = capWindowOf(s.anchor_date, easternDay(now));
        if (eff.cap === null || !capActsOn(status) || !w) return null;
        const used = (await leadsInWindow(s, w)).length;
        return used >= eff.cap ? { cap: eff.cap, used, window: w } : null;
      }
      // Held already is still held, whatever the cap has become: only a person's press moves it, and held replies aren't in the count.
      if (!held && (eff.cap === null || !capActsOn(status))) return null;
      const w = held ? capWindowOf(held.window_start, held.window_start) : capWindowOf(s.anchor_date, easternDay(at));
      if (!w) return null;
      const list = await leadsOf(w);
      if (held) return { cap: eff.cap ?? list.length, used: list.length, window: w };
      return isOverCap(list, threadId, eff.cap as number) ? { cap: eff.cap as number, used: list.length, window: w } : null;
    },
    async hold({ osClientId, clientName, relayId, threadId, agentName, agentEmail, over, workspaceId }) {
      const now = new Date();
      const before = (await heldLeadsOf(osClientId)).find((h) => h.thread_id === threadId);
      const { error } = await osTable("os_cap_held_leads").upsert(
        { thread_id: threadId, os_client_id: osClientId, relay_id: relayId, agent_name: agentName, agent_email: agentEmail, window_start: over.window.start, held_at: now.toISOString() },
        { onConflict: "thread_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(`os_cap_held_leads: ${error.message}`);
      if (before?.released_at) {
        const { error: backErr } = await osTable("os_cap_held_leads").update({ released_at: null, released_by: null, labelled_at: null, window_start: over.window.start }).eq("thread_id", threadId);
        if (backErr) throw new Error(`os_cap_held_leads: ${backErr.message}`);
      }
      const label = await moveToKeepWarm(osClientId, workspaceId, threadId, now);
      const where = label === "moved" ? "and is in Keep Warm" : label === "left" ? "and keeps the label it has" : "and couldn't be moved to Keep Warm yet";
      const who = agentName ?? agentEmail ?? "An agent";
      const capWords = over.cap ? `its cap of ${leadsWord(over.cap)}` : "its cap";
      await tellBell({
        kind: "lead_cap_held", severity: "info", osClientId, ref: before?.released_at ? `cap_reheld:${threadId}:${easternDay(now)}` : `cap_held:${threadId}`,
        title: `${clientName}: a reply over the cap was held`,
        body: before?.released_at
          ? `${who}'s reply was pressed to send but couldn't go then, and ${clientName} has since reached ${capWords}. It was not sent or charged, ${where}. It can be sent again once there is room: the window reopens on ${say(over.window.end)}.`
          : `${who} replied after ${clientName} reached ${capWords}. It was not sent to the client and not charged, ${where}. It can be sent from the conversation once there is room: the window reopens on ${say(over.window.end)}.`,
      });
    },
    async roomFor({ osClientId, now }) {
      const s = await loadSettings(osClientId);
      if (!s) return null;
      const { eff, name } = await capInputs(s);
      if (eff.cap === null) return null;
      const w = capWindowOf(s.anchor_date, easternDay(now));
      if (!w) return null;
      const used = (await leadsInWindow(s, w)).length;
      if (used < eff.cap) return null;
      return `${name} is at its cap (${used} of ${eff.cap}) until ${say(w.end)}, so this wasn't sent. Send it once the window reopens, or raise its cap first.`;
    },
    async backToInterested({ threadId, workspaceId }) {
      await applyNamedLabel(workspaceId, threadId, "Interested");
    },
    async markReleased({ threadId, who, now }) {
      // Stamped afresh on every press: a press that died is only reset (finishHolds) if nobody has pressed since.
      const { error } = await osTable("os_cap_held_leads").update({ released_at: now.toISOString(), released_by: who }).eq("thread_id", threadId);
      if (error) throw new Error(`os_cap_held_leads: ${error.message}`);
    },
  };
}

/* ---------------------------------------------------------------- the run --- */

export interface CapRunResult {
  live: boolean;
  /** Replies past the cap are held too. */
  holding: boolean;
  /** Clients the cap acts on, or that are still owed a restart. */
  clients: number;
  reached: number;
  paused: number;
  restarted: number;
  /** What a dry run would have done, and anything worth a log line. */
  notes: string[];
  errors: string[];
}

export async function runLeadCaps(o: { env?: Env; now?: Date; source?: LeadSourceFn } = {}): Promise<CapRunResult> {
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  const out: CapRunResult = { live: capsLive(env), holding: capsHoldLive(env), clients: 0, reached: 0, paused: 0, restarted: 0, notes: [], errors: [] };
  let rows: SettingsRow[];
  try {
    rows = await allSettings();
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e));
    return out;
  }
  for (const s of rows) {
    // One client's failure never stops another's.
    try {
      await capClient(s, now, out, o.source);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out.errors.push(`${s.os_client_id}: ${message}`);
      // Left to the log, a client at its cap would go on emailing with nobody told.
      if (out.live && capAppliesTo(s)) {
        try {
          await tellBell({
            kind: "lead_cap_problem", severity: "warning", osClientId: s.os_client_id, ref: `cap_run_failed:${s.os_client_id}:${easternDay(now)}`,
            title: "A client's lead cap couldn't be checked",
            body: `${message.slice(0, 300)} Its campaigns may still be running past its cap. The run keeps trying.`,
          });
        } catch { /* the error is in the run's log already */ }
      }
    }
  }
  return out;
}

async function capClient(s: SettingsRow, now: Date, out: CapRunResult, source?: LeadSourceFn): Promise<void> {
  const id = s.os_client_id;
  const w = capWindowOf(s.anchor_date, easternDay(now));
  if (!w) return;
  const applies = capAppliesTo(s);
  const rows = await windowRows(id);
  const listed = rows.filter((r) => stillListed(r).length);
  // A restart it owes from before is still owed, whatever the client's billing has become since.
  if (!applies && !listed.length) return;
  out.clients += 1;
  // First and on its own: it needs no cap, and a reply whose hold didn't finish is counted on the invoice until it does.
  if (out.live && applies) {
    try {
      await finishHolds(id, w, now);
    } catch (e) {
      out.errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const { eff, name, status, chId } = await capInputs(s);
  const used = applies && eff.cap !== null ? (await leadsInWindow(s, w, source)).length : 0;
  const reached = applies && eff.cap !== null && used >= eff.cap;
  if (reached) out.reached += 1;

  if (!out.live) {
    if (reached) {
      const plan = chId && capActsOn(status) ? await planToggle(chId, "pause") : null;
      out.notes.push(`${name}: ${used} of ${eff.cap} for ${periodLabel(w)}, would pause ${plan?.willChange.length ? names(plan.willChange) : "nothing (none running)"}, restart ${w.end}`);
    }
    if (listed.length) out.notes.push(`${name}: caps are off, so nothing restarts by itself: ${names(listed.flatMap((r) => stillListed(r)))}`);
    return;
  }

  if (eff.spendInvalid) {
    await tellBell({
      kind: "lead_cap_problem", severity: "warning", osClientId: id, ref: `cap_spend_invalid:${id}:${w.start}`,
      title: `${name}: its spend limit isn't being applied`,
      body: `Its spend limit is less than one lead at its price, so it can't be met. It is ignored until it is changed on the Billing tab.`,
    });
  }

  // 1. Not at the cap: a listed campaign that is running was restarted by a person, so it is theirs again.
  //    A later pause by hand then stays paused. (At the cap, step 3 pauses it again instead.)
  if (!reached && chId && listed.length) {
    const running = new Set((await planToggle(chId, "pause")).willChange.map(keyOf));
    for (const r of listed) {
      if (stillListed(r).some((c) => running.has(keyOf(c)))) await changeWindow(id, r, (fresh) => ({ paused: stillListed(fresh).filter((c) => !running.has(keyOf(c))) }));
    }
  }

  // 2. Campaigns waiting from an earlier window.
  const waiting = (listed.length ? await windowRows(id) : []).filter((r) => r.window_start < w.start && stillListed(r).length);
  if (waiting.length) await restartWaiting(id, name, status, chId, waiting, w, reached, now, out);

  // 3. At the cap in this window: stop whatever is sending, however it came to be running.
  if (reached && capActsOn(status)) await pauseAtCap(id, name, chId, w, used, eff.cap as number, now, out);

  // 4. A new window after a capped one: the plan says campaigns resume now, and one paused by hand doesn't, so say so once.
  if (applies && chId && capActsOn(status) && easternDay(now) === w.start && easternHour(now) >= CAP_RESTART_FROM_HOUR_ET) {
    const previous = rows.filter((r) => r.window_end === w.start && r.reached_at);
    if (previous.length) await sayStillPaused(id, name, chId, previous, w);
  }
}

async function sayStillPaused(id: string, name: string, chId: string, previous: WindowRow[], w: CapWindow): Promise<void> {
  // Read now: step 3 may have just paused one for this window, and that isn't what this is about.
  const current = (await windowRows(id)).filter((r) => r.window_start === w.start);
  const handled = new Set([...previous, ...current].flatMap((r) => campaignsFromJson(r.paused)).map(keyOf));
  const paused = (await liveCampaigns(chId)).filter((c) => c.status === "paused" && !handled.has(keyOf(c)));
  if (!paused.length) return;
  await tellBell({
    kind: "lead_cap_problem", severity: "warning", osClientId: id, ref: `cap_still_paused:${id}:${w.start}`,
    title: `${name}: a campaign is still paused in the new window`,
    body: `${names(paused)} is still paused and isn't on the restart list, so the new window didn't restart it. If it should be running, restart it from Client Health.`,
  });
}

const RELEASE_LEFT_AFTER_MS = 10 * 60_000;

async function finishHolds(id: string, w: CapWindow, now: Date): Promise<void> {
  const held = await heldLeadsOf(id);
  const { data, error } = await osTable("os_brokerage_relays").select("id, thread_id, workspace_id, agent_name, agent_email, brokerage_name").eq("os_client_id", id).eq("status", "held").eq("reason", "over_cap");
  if (error) throw new Error(`os_brokerage_relays: ${error.message}`);
  const records = (data ?? []) as Row[];
  const known = new Map(held.map((h) => [h.thread_id, h]));
  for (const r of records) {
    const h = known.get(String(r.thread_id));
    if (!h) {
      await relayCapHook().hold({
        osClientId: id, clientName: String(r.brokerage_name ?? "This client"), relayId: String(r.id), threadId: String(r.thread_id),
        agentName: (r.agent_name as string | null) ?? null, agentEmail: (r.agent_email as string | null) ?? null,
        over: { cap: 0, used: 0, window: w }, workspaceId: String(r.workspace_id),
      });
    } else if (h.released_at && now.getTime() - Date.parse(h.released_at) > RELEASE_LEFT_AFTER_MS) {
      // A press that died between marking it released and moving the record: back to waiting, so it shows and can be pressed again.
      const { error: backErr } = await osTable("os_cap_held_leads").update({ released_at: null, released_by: null, labelled_at: null }).eq("thread_id", h.thread_id).eq("released_at", h.released_at);
      if (backErr) throw new Error(`os_cap_held_leads: ${backErr.message}`);
      h.released_at = null;
      h.labelled_at = null;
    }
  }
  const unlabelled = held.filter((h) => !h.labelled_at && !h.released_at);
  if (!unlabelled.length) return;
  const workspaceId = await workspaceOfHeld(id);
  if (workspaceId) for (const h of unlabelled) await moveToKeepWarm(id, workspaceId, h.thread_id, now);
}

async function workspaceOfHeld(osClientId: string): Promise<string | null> {
  const { data, error } = await osTable("os_brokerage_relays").select("workspace_id").eq("os_client_id", osClientId).limit(1).maybeSingle();
  return error ? null : ((data as Row | null)?.workspace_id as string | undefined) ?? null;
}

/**
 * Restarts what is listed and closes the rows, except what refused or couldn't be read: that stays listed, is tried
 * again, and the team is told. Listed but never confirmed paused by this: a person may have paused it (the bell for a
 * failed pause tells them to), so it isn't restarted, and if it is paused they are told so.
 */
async function restartListed(id: string, name: string, chId: string, rows: WindowRow[], list: CapCampaign[], actor: string, retry: string, now: Date): Promise<{ restarted: PlannedCampaign[]; again: CapCampaign[] }> {
  const nowIso = now.toISOString();
  const confirmed = list.filter((c) => c.confirmed);
  const r = confirmed.length ? await resumeListed(chId, confirmed, actor) : null;
  const outcomes = r?.outcomes ?? [];
  const restarted = outcomes.filter((o) => o.ok).map((o) => o.campaign);
  const redo = new Set([
    ...outcomes.filter((o) => !o.ok).map((o) => keyOf(o.campaign)),
    ...(r?.plan.skipped ?? []).filter((x) => statusUnread(x.campaign.status)).map((x) => keyOf(x.campaign)),
  ]);
  const again = confirmed.filter((c) => redo.has(keyOf(c)));
  // What is tried again stays on the oldest row, the one the run comes back to soonest.
  const [first, ...rest] = [...rows].sort((a, b) => a.window_start.localeCompare(b.window_start));
  await changeWindow(id, first, () => (again.length ? { paused: again } : { restarted_at: nowIso }));
  for (const row of rest) await changeWindow(id, row, () => ({ restarted_at: nowIso }));
  if (again.length) {
    await tellBell({
      kind: "lead_cap_problem", severity: "critical", osClientId: id, ref: `cap_restart_failed:${id}:${easternDay(now)}`,
      title: `${name}: campaigns didn't restart`,
      body: `${names(again)} could not be restarted. ${retry}`,
    });
  }
  // Neither restarted nor running nor finished, and not being tried again: it stays paused, and someone has to know.
  const lost = (r?.plan.skipped ?? []).filter((x) => !statusUnread(x.campaign.status) && !isSending(x.campaign) && x.campaign.status !== "completed" && x.campaign.status !== "deleted");
  if (lost.length) {
    await tellBell({
      kind: "lead_cap_problem", severity: "warning", osClientId: id, ref: `cap_restart_lost:${id}:${easternDay(now)}`,
      title: `${name}: a paused campaign wasn't restarted`,
      body: lost.map((x) => (x.campaign.status === "not linked"
        ? `${x.campaign.name} is no longer linked to this client, so it wasn't restarted. Check which client it belongs to.`
        : `${x.campaign.name} (${x.reason}) stays paused. Restart it from Client Health if it should run.`)).join(" "),
    });
  }
  const unconfirmed = list.filter((c) => !c.confirmed);
  if (unconfirmed.length) {
    const mine = new Set(unconfirmed.map(keyOf));
    const stillPaused = (await liveCampaigns(chId)).filter((c) => c.status === "paused" && mine.has(keyOf(c)));
    if (stillPaused.length) {
      await tellBell({
        kind: "lead_cap_problem", severity: "warning", osClientId: id, ref: `cap_unconfirmed:${id}:${easternDay(now)}`,
        title: `${name}: a paused campaign wasn't restarted`,
        body: `${names(stillPaused)} is paused, but the lead cap couldn't confirm it did that, so a person may have. It stays paused. Restart it from Client Health if it should run.`,
      });
    }
  }
  return { restarted, again };
}

async function restartWaiting(id: string, name: string, status: string | null, chId: string | null, waiting: WindowRow[], w: CapWindow, reached: boolean, now: Date, out: CapRunResult): Promise<void> {
  const list = waiting.reduce<CapCampaign[]>((all, r) => mergeCampaigns(all, stillListed(r)), []);
  const close = async (patch: Row) => { for (const r of waiting) await changeWindow(id, r, () => patch); };
  // A paused or churned client's campaigns are the lifecycle's: never restarted from here.
  if (!capActsOn(status) || !chId) {
    await close({ restarted_at: now.toISOString(), note: `not restarted: the client is ${status ?? "not linked"}` });
    await tellBell({
      kind: "lead_cap_problem", severity: "warning", osClientId: id, ref: `cap_not_restarted:${id}:${w.start}`,
      title: `${name}: campaigns not restarted`,
      body: `${names(list)} would restart for the new window, but the client is ${status ?? "not linked to Client Health"}, so they stay paused.`,
    });
    return;
  }
  // Already at the cap in the new window (a released reply, a fast start): they wait for the next one.
  if (reached) {
    await changeWindow(id, windowRowOf(w), (fresh) => ({ paused: mergeCampaigns(stillListed(fresh), list), restarted_at: null }));
    await close({ restarted_at: now.toISOString(), note: "carried to the next window: already at the cap" });
    return;
  }
  if (easternHour(now) < CAP_RESTART_FROM_HOUR_ET) return;
  const { restarted, again } = await restartListed(id, name, chId, waiting, list, ACTOR, "The run keeps trying.", now);
  out.restarted += restarted.length;
  if (restarted.length && !again.length) {
    await tellBell({
      kind: "lead_cap_restarted", severity: "info", osClientId: id, ref: `cap_restarted:${id}:${w.start}`,
      title: `${name}: campaigns restarted`,
      body: `${names(restarted)} restarted for the window starting ${say(w.start)}.`,
    });
  }
}

async function pauseAtCap(id: string, name: string, chId: string | null, w: CapWindow, used: number, cap: number, now: Date, out: CapRunResult): Promise<void> {
  const row = windowRowOf(w);
  const nowIso = now.toISOString();
  const cur = (await windowRows(id)).find((r) => r.window_start === w.start) ?? null;
  const firstTime = !cur?.reached_at;
  if (!chId) {
    if (firstTime) await changeWindow(id, row, (fresh) => ({ reached_at: fresh?.reached_at ?? nowIso }));
    await tellBell({
      kind: "lead_cap_problem", severity: "critical", osClientId: id, ref: `cap_no_link:${id}:${w.start}`,
      title: `${name} reached its cap, but its campaigns couldn't be paused`,
      body: `It isn't linked to Client Health, so its campaigns aren't known here. Pause them by hand. ${repliesWords(out.holding)}`,
    });
    return;
  }
  const plan = await planToggle(chId, "pause");
  // A campaign linked to another client too: stopping it would stop that client's emails, on this client's cap.
  const shared = plan.willChange.length ? await sharedWithOthers(chId, plan.willChange) : new Map<string, string[]>();
  const toPause = plan.willChange.filter((c) => !shared.has(keyOf(c)));
  const planned = toPause.map((c) => asCampaign(c, nowIso, false));
  const plannedKeys = new Set(planned.map(keyOf));
  // Written BEFORE anything is paused: a crash in between must not leave a campaign paused that nothing knows about.
  // Only one confirmed below restarts by itself, and one running now isn't confirmed paused, whatever it was before.
  if (firstTime || planned.length) {
    await changeWindow(id, row, (fresh) => ({ reached_at: fresh?.reached_at ?? nowIso, paused: [...stillListed(fresh).filter((c) => !plannedKeys.has(keyOf(c))), ...planned], restarted_at: null }));
  }
  let done: PlannedCampaign[] = [];
  let failed: Array<{ campaign: PlannedCampaign; error?: string }> = [];
  if (toPause.length) {
    const r = await pauseListed(chId, toPause, ACTOR);
    done = r.outcomes.filter((o) => o.ok).map((o) => o.campaign);
    failed = r.outcomes.filter((o) => !o.ok);
    out.paused += done.length;
    if (done.length) await changeWindow(id, row, (fresh) => ({ paused: mergeCampaigns(stillListed(fresh), done.map((c) => asCampaign(c, nowIso, true))) }));
    if (failed.length) {
      await tellBell({
        kind: "lead_cap_problem", severity: "critical", osClientId: id, ref: `cap_pause_failed:${id}:${easternDay(now)}`,
        title: `${name} reached its cap, but a campaign is still running`,
        body: `${names(failed.map((o) => o.campaign))} could not be paused: ${(failed[0].error ?? "").slice(0, 200)}. The run keeps trying. If you pause it by hand, it stays paused at the new window unless you add it to the restart on the Billing tab.`,
      });
    }
  }
  if (shared.size) {
    const list = plan.willChange.filter((c) => shared.has(keyOf(c)));
    await tellBell({
      kind: "lead_cap_problem", severity: "critical", osClientId: id, ref: `cap_shared:${id}:${w.start}`,
      title: `${name} reached its cap, but a shared campaign is still running`,
      body: `${list.map((c) => `${c.name} is also linked to ${shared.get(keyOf(c))!.join(", ")}`).join(". ")}. It was left running, because pausing it would stop that client's emails too. Sort out which client it belongs to, or pause it by hand.`,
    });
  }
  const unknown = plan.skipped.filter((x) => statusUnread(x.campaign.status));
  if (unknown.length) {
    await tellBell({
      kind: "lead_cap_problem", severity: "warning", osClientId: id, ref: `cap_status_unknown:${id}:${easternDay(now)}`,
      title: `${name}: some campaigns couldn't be checked`,
      body: `${name} is at its cap, but ${names(unknown.map((x) => x.campaign))} couldn't be read, so it may still be running. The run keeps trying.`,
    });
  }
  if (firstTime) {
    const what = done.length ? `Paused ${names(done)}.`
      : failed.length ? `${names(failed.map((o) => o.campaign))} could not be paused.`
      : shared.size || unknown.length ? "Not every campaign could be paused."
      : "No linked campaign was running.";
    const listedNow = new Set(stillListed(cur).map(keyOf));
    const byHand = plan.skipped.filter((x) => x.campaign.status === "paused" && !listedNow.has(keyOf(x.campaign))).map((x) => x.campaign);
    const handWords = byHand.length ? ` ${names(byHand)} was already paused by hand, so it won't restart then unless you add it on the Billing tab.` : "";
    await tellBell({
      kind: "lead_cap_reached", severity: "warning", osClientId: id, ref: `cap_reached:${id}:${w.start}`,
      title: `${name} reached its cap`,
      body: `${used} of ${cap} leads for ${periodLabel(w)}. ${what} Campaigns it paused restart on ${say(w.end)}.${handWords} ${repliesWords(out.holding)}`,
    });
  } else if (done.length) {
    await tellBell({
      kind: "lead_cap_reached", severity: "warning", osClientId: id, ref: `cap_repaused:${id}:${easternDay(now)}`,
      title: `${name}: paused a campaign again`,
      body: `${names(done)} was running while ${name} is at its cap (${used} of ${cap}), so it was paused again until ${say(w.end)}. To let it run, raise the cap first.`,
    });
  }
}

/* ------------------------------------------------- the Billing tab's view --- */

export interface CapView {
  live: boolean;
  /** Replies past the cap are held too. Otherwise they go to the client and are billed. */
  holding: boolean;
  /** Why this client's cap doesn't act, in words, or null when it does. */
  notActing: string | null;
  window: { start: string; end: string; label: string } | null;
  cap: number | null;
  leadCap: number | null;
  spendCapCents: number | null;
  spendLeads: number | null;
  spendInvalid: boolean;
  by: EffectiveCap["by"];
  /** Null when it couldn't be read for a client with no cap, where it is only for information. */
  used: number | null;
  reached: boolean;
  linked: boolean;
  canSaveSpend: boolean;
  /** What restarts. */
  waiting: Array<{ platform: string; id: string; name: string }>;
  /** It is owed from an earlier window, so it goes today from 9am Eastern rather than at the next window. */
  restartsToday: boolean;
  /** Otherwise what is waiting stays paused until a person presses Play: caps are off, or the client is paused or churned. */
  restartsByItself: boolean;
  /** Live-paused and not on that list: a person paused them, or it couldn't be confirmed, so they stay paused unless added. */
  pausedOtherwise: Array<{ platform: string; id: string; name: string }>;
  campaignsError: string | null;
  held: Array<{ threadId: string; name: string; at: string }>;
}

function whyNotActing(s: SettingsRow, status: string | null): string | null {
  if (modeOf(s) !== "live") return "Its billing is still in test, so this cap won't act until the client goes live.";
  if (!capAppliesTo(s)) return "This client isn't billed per hand-off, so its cap doesn't act.";
  if (!capActsOn(status)) return `This client is ${status ?? "not active"}, so its cap doesn't act.`;
  return null;
}

export async function capView(osClientId: string, s: SettingsRow, env: Env = process.env, now = new Date()): Promise<CapView> {
  const w = capWindowOf(s.anchor_date, easternDay(now));
  const { eff, chId, spendReady, status } = await capInputs(s);
  let used: number | null = 0;
  if (w) {
    try {
      used = (await leadsInWindow(s, w)).length;
    } catch (e) {
      // With a cap, an unknown count is an error. Without one, a spend limit must still be settable.
      if (eff.cap !== null) throw e;
      used = null;
    }
  }
  const rows = await windowRows(osClientId);
  const inView = rows.filter((r) => !w || r.window_start <= w.start);
  const listed = inView.reduce<CapCampaign[]>((all, r) => mergeCampaigns(all, stillListed(r)), []);
  const waiting = listed.filter((c) => c.confirmed);
  const notActing = whyNotActing(s, status);
  let pausedOtherwise: CapView["pausedOtherwise"] = [];
  let campaignsError: string | null = null;
  const reached = !notActing && eff.cap !== null && (used ?? 0) >= eff.cap;
  if (chId && (reached || listed.length)) {
    try {
      const mine = new Set(waiting.map(keyOf));
      pausedOtherwise = (await liveCampaigns(chId)).filter((c) => c.status === "paused" && !mine.has(keyOf(c))).map((c) => ({ platform: c.platform, id: c.id, name: c.name }));
    } catch (e) {
      campaignsError = e instanceof Error ? e.message : String(e);
    }
  }
  // One a person has since labelled something else (a decline, say) has been decided: it no longer waits on anyone.
  const waitingOnSomeone = await Promise.all((await heldLeadsOf(osClientId)).filter((h) => !h.released_at).map(async (h) => {
    const labels = await labelNamesOf(h.thread_id).catch(() => [] as string[]);
    return labels.every((l) => ["keep warm", "interested", "meetings booked"].includes(l.trim().toLowerCase())) ? [h] : [];
  }));
  const held = waitingOnSomeone.flat().map((h) => ({ threadId: h.thread_id, name: h.agent_name ?? h.agent_email ?? "Agent", at: h.held_at }));
  return {
    live: capsLive(env),
    holding: capsHoldLive(env),
    notActing,
    window: w ? { ...w, label: periodLabel(w) } : null,
    cap: eff.cap, leadCap: eff.leadCap, spendCapCents: eff.spendCapCents, spendLeads: eff.spendLeads, spendInvalid: eff.spendInvalid, by: eff.by,
    used, reached, linked: !!chId, canSaveSpend: spendReady,
    waiting: waiting.map((c) => ({ platform: c.platform, id: c.id, name: c.name })),
    restartsToday: !!w && inView.some((r) => r.window_start < w.start && stillListed(r).some((c) => c.confirmed)),
    restartsByItself: capsLive(env) && capActsOn(status) && !!chId,
    pausedOtherwise, campaignsError, held,
  };
}

/* ------------------------------------------------------------ what people press --- */

/** The spend limit, and nothing else on the row: a page left open can't move the price or schedule of a live client through this. */
export async function setSpendCap(osClientId: string, s: SettingsRow, raw: unknown, by: string, now = new Date()): Promise<void> {
  const parsed = parseSpendCap(raw, s.price_cents);
  if ("error" in parsed) throw new UsageBillingError(parsed.error, 400);
  const { error } = await osTable("os_usage_billing_settings")
    .update({ spend_cap_cents: parsed.cents, updated_by: by, updated_at: now.toISOString() })
    .eq("os_client_id", osClientId);
  if (error) {
    if (columnIsMissing(error)) throw new UsageBillingError("The spend limit needs database migration 0049 first.", 503);
    throw new UsageBillingError(error.message, 502);
  }
}

interface PressOptions { env?: Env; now?: Date }

/** These move real campaigns, so the button being greyed out isn't enough: a page left open can still send them. */
async function mayPress(s: SettingsRow, env: Env): Promise<CapInputs> {
  if (!capsLive(env)) throw new UsageBillingError("Lead caps aren't switched on, so this does nothing yet.", 409);
  const input = await capInputs(s);
  const why = whyNotActing(s, input.status);
  if (why) throw new UsageBillingError(why, 409);
  return input;
}

/**
 * A campaign a person paused by hand, added to the restart: Homebase's was paused in EmailBison before this existed.
 * Only one linked to this client, paused right now, while the client is at its cap, since that's the only time a
 * restart is coming.
 */
export async function addToRestart(osClientId: string, s: SettingsRow, campaign: { platform?: unknown; id?: unknown }, o: PressOptions = {}): Promise<void> {
  const now = o.now ?? new Date();
  const { eff, chId } = await mayPress(s, o.env ?? process.env);
  const w = capWindowOf(s.anchor_date, easternDay(now));
  if (!chId || !w || eff.cap === null) throw new UsageBillingError("This client has no cap, so nothing restarts.", 409);
  if ((await leadsInWindow(s, w)).length < eff.cap) throw new UsageBillingError("This client isn't at its cap, so no restart is coming.", 409);
  const found = (await liveCampaigns(chId)).find((c) => c.platform === campaign.platform && c.id === campaign.id);
  if (!found) throw new UsageBillingError("That campaign isn't linked to this client.", 404);
  if (found.status !== "paused") throw new UsageBillingError(`That campaign is ${found.status}, not paused.`, 409);
  const nowIso = now.toISOString();
  await changeWindow(osClientId, windowRowOf(w), (fresh) => ({
    reached_at: fresh?.reached_at ?? nowIso,
    paused: mergeCampaigns(stillListed(fresh), [asCampaign(found, nowIso, true)]),
    restarted_at: null,
  }));
}

/** A campaign that should stay paused past the window: off the list, so nothing restarts it. */
export async function removeFromRestart(osClientId: string, s: SettingsRow, campaign: { platform?: unknown; id?: unknown }, o: PressOptions = {}): Promise<void> {
  await mayPress(s, o.env ?? process.env);
  const key = `${String(campaign.platform)}:${String(campaign.id)}`;
  const rows = (await windowRows(osClientId)).filter((r) => stillListed(r).some((c) => keyOf(c) === key));
  if (!rows.length) throw new UsageBillingError("That campaign isn't waiting to restart.", 404);
  for (const r of rows) await changeWindow(osClientId, r, (fresh) => ({ paused: stillListed(fresh).filter((c) => keyOf(c) !== key) }));
}

/** Restart now, when the client is back under its cap: its cap was raised, or a lead was corrected. Refused at the cap. */
export async function restartNow(osClientId: string, s: SettingsRow, by: string, o: PressOptions = {}): Promise<{ restarted: number }> {
  const now = o.now ?? new Date();
  const { eff, chId, name } = await mayPress(s, o.env ?? process.env);
  const w = capWindowOf(s.anchor_date, easternDay(now));
  if (!chId || !w) throw new UsageBillingError("This client isn't linked to its campaigns.", 409);
  if (eff.cap !== null && (await leadsInWindow(s, w)).length >= eff.cap) throw new UsageBillingError("This client is at its cap. Raise the cap first, or wait for the new window.", 409);
  const rows = (await windowRows(osClientId)).filter((r) => stillListed(r).length);
  const list = rows.reduce<CapCampaign[]>((all, r) => mergeCampaigns(all, stillListed(r)), []);
  if (!list.length) return { restarted: 0 };
  const retry = "Press Restart now again, or it restarts with the new window.";
  const { restarted, again } = await restartListed(osClientId, name, chId, rows, list, `${ACTOR} (${by})`, retry, now);
  if (again.length) throw new UsageBillingError(`${names(again)} could not be restarted. ${retry}`, 502);
  return { restarted: restarted.length };
}
