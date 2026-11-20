import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { tableIsMissing } from "@/lib/clients/usage-billing/caps-model";

import { pauseListed, planToggle, type PlannedCampaign } from "./campaign-toggle";
import {
  ACTOR, UNREAD_STATUSES, afterAttempt, cyclePauseLive, isoDay, judge, keyOf, names, progressState, reachedAt, recordForCycle, sharedWith, shortDay, splitShared,
  type CycleCampaign, type CycleFacts, type CyclePauseRecord, type CycleProgress, type CycleProgressView, type Judgement, type RetryCampaign,
} from "./cycle-pause-model.ts";
import { loadDashboardClients } from "./loadDashboard";
import { healthSnapshot } from "./per-lead";
import type { DashboardClient } from "./types";
import { getWeekly } from "./weekly";

/*
 * BILLING-CYCLE AUTO-PAUSE: the sweep (rules and reasons: cycle-pause-model.ts).
 *
 * Every 15 minutes on Railway (instrumentation.ts). Reads Client Health fresh, judges every client, and, with
 * OS_CYCLE_PAUSE=1, pauses the sending campaigns of each client whose cycle reached its due, through the same pause
 * Client Health's Pause button uses (campaign-toggle.ts): live statuses, the held list Play resumes, the toggle log.
 * Without the switch it writes nothing and pauses nothing; the log says what it would have done.
 *
 * It refuses to act on anything less than the full picture: seed data, an unread list of per-lead clients (they would
 * be judged by introductions), unread Stripe dates (the cycle could be the wrong one), or no os_cycle_pauses table
 * (it couldn't remember acting, so it would pause again after every resume).
 */

const TABLE = "os_cycle_pauses";
const STATE = "os_cycle_pause_state";
/** Off for longer than this (no live run): switching it on again starts afresh, so only clients reaching their due after that are paused. */
const RESTART_AFTER_MS = 60 * 60_000;
/** This server's start: what a dry run measures "after it was switched on" against, so its log previews what live would do. */
const STARTED = new Date().toISOString();
const COLUMNS = "os_client_id, cycle_start, cycle_end, required, delivered, reached_at, paused, left_running, to_retry, updated_at";

export interface CyclePauseRunResult {
  live: boolean;
  clients: number;
  reached: number;
  paused: number;
  leftRunning: number;
  notes: string[];
  errors: string[];
}

interface OsLink {
  id: string;
  name: string;
  status: string | null;
  analyticsId: string | null;
}

/** os_clients by Client Health id. A Client Health client two OS clients point at is left out: it's unclear whose it is. */
async function osLinks(): Promise<{ byCh: Map<string, OsLink>; doubled: Set<string> }> {
  const { data, error } = await osTable("os_clients").select("id, name, status, ch_client_id, an_client_id").not("ch_client_id", "is", null);
  if (error) throw new Error(`os_clients: ${error.message}`);
  const byCh = new Map<string, OsLink>();
  const doubled = new Set<string>();
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const ch = typeof r.ch_client_id === "string" ? r.ch_client_id : "";
    if (!ch) continue;
    if (byCh.has(ch)) doubled.add(ch);
    byCh.set(ch, {
      id: String(r.id),
      name: typeof r.name === "string" ? r.name : "",
      status: typeof r.status === "string" ? r.status : null,
      analyticsId: typeof r.an_client_id === "string" && r.an_client_id ? r.an_client_id : null,
    });
  }
  for (const ch of doubled) byCh.delete(ch);
  return { byCh, doubled };
}

/** Records recent enough to overlap a cycle in progress. Null when the table isn't there yet (migration 0054). */
async function recentRecords(now: Date): Promise<Map<string, CyclePauseRecord[]> | null> {
  const since = isoDay(new Date(now.getTime() - 120 * 86_400_000));
  const { data, error } = await osTable(TABLE).select(COLUMNS).gte("cycle_end", since);
  if (error) {
    if (tableIsMissing(error)) return null;
    throw new Error(`${TABLE}: ${error.message}`);
  }
  const out = new Map<string, CyclePauseRecord[]>();
  for (const r of (data ?? []) as unknown as CyclePauseRecord[]) {
    const row: CyclePauseRecord = { ...r, paused: arr(r.paused), left_running: arr(r.left_running), to_retry: arr(r.to_retry) };
    out.set(row.os_client_id, [...(out.get(row.os_client_id) ?? []), row]);
  }
  return out;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const cycleOf = (c: DashboardClient, now: Date): CycleFacts | null => {
  const snap = healthSnapshot(c, now);
  if (!snap) return null;
  const cycle = { start: snap.cycle.start, end: snap.cycle.end, target: snap.cycle.target, required: snap.cycle.required, delivered: snap.cycle.delivered };
  return { ...cycle, reachedAt: reachedAt(c.intro_dates ?? [], cycle, cycle.required, now) };
};

/*
 * When the pause was switched on (the team, 20 Nov: only clients reaching their due after that are paused). Written on
 * the first live run, and again whenever the last live run is over an hour old (switched off and on, or the service
 * down): a client that reached its due meanwhile is left to the team, never paused late. Live runs only: a dry run
 * writes nothing and measures against this server's start. Unreadable: throws, and nothing is paused.
 */
async function switchedOnAt(now: Date): Promise<string> {
  const { data, error } = await osTable(STATE).select("live_since, last_live_run_at").eq("id", "default").maybeSingle();
  if (error) throw new Error(`${STATE}: ${error.message}`);
  const row = (data ?? null) as { live_since: string | null; last_live_run_at: string | null } | null;
  const last = row?.last_live_run_at ? Date.parse(row.last_live_run_at) : NaN;
  const fresh = !row?.live_since || !Number.isFinite(last) || now.getTime() - last > RESTART_AFTER_MS;
  const since = fresh ? now.toISOString() : String(row!.live_since);
  const { error: wErr } = await osTable(STATE).upsert({ id: "default", live_since: since, last_live_run_at: now.toISOString(), updated_at: now.toISOString() }, { onConflict: "id" });
  if (wErr) throw new Error(`${STATE}: ${wErr.message}`);
  return since;
}

/** "since Nov 3, due Dec 1": the cycle as Intros / Billing shows it (the next billing date is in it). */
const spanOf = (cycle: Pick<CycleFacts, "start" | "end">): string => `since ${shortDay(isoDay(cycle.start))}, due ${shortDay(isoDay(cycle.end))}`;

export async function runCyclePauses(o: { env?: Record<string, string | undefined>; now?: Date; dryRunSince?: string } = {}): Promise<CyclePauseRunResult> {
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  const out: CyclePauseRunResult = { live: cyclePauseLive(env), clients: 0, reached: 0, paused: 0, leftRunning: 0, notes: [], errors: [] };

  const loaded = await loadDashboardClients();
  if (loaded.source !== "supabase" || loaded.error) {
    out.errors.push(`Client Health couldn't be read (${loaded.error ?? "seed data"}), so nothing was judged`);
    return out;
  }
  if (loaded.perLeadError) {
    out.errors.push(`the clients billed per lead couldn't be read (${loaded.perLeadError}), so nothing was judged`);
    return out;
  }
  if (loaded.datesUnsure) {
    out.errors.push(`${loaded.datesUnsure}, so the cycle dates may be wrong and nothing was judged`);
    return out;
  }
  const [{ byCh, doubled }, records] = await Promise.all([osLinks(), recentRecords(now)]);
  if (records === null) {
    if (out.live) {
      out.errors.push(`${TABLE} isn't there (migration 0054), so nothing was paused: it couldn't remember a pause, and would pause again after every resume`);
      return out;
    }
    out.notes.push(`${TABLE} isn't there yet (migration 0054)`);
  }
  let liveSince = o.dryRunSince ?? STARTED;
  if (out.live) {
    try {
      liveSince = await switchedOnAt(now);
    } catch (e) {
      out.errors.push(`${e instanceof Error ? e.message : String(e)}: when it was switched on is unknown, so nothing was paused`);
      return out;
    }
  }

  for (const c of loaded.clients) {
    if (doubled.has(c.id)) {
      out.errors.push(`${c.name}: two OS clients are linked to it, so it was left alone`);
      continue;
    }
    const link = byCh.get(c.id);
    if (!link) continue;
    const cycle = cycleOf(c, now);
    const record = cycle ? recordForCycle(records?.get(link.id) ?? [], cycle) : null;
    const j = judge({ status: link.status, clientPaused: c.client_paused, perLead: !!c.per_lead, cycle, record, liveSince });
    if (j.kind === "skip" || j.kind === "below") continue;
    out.clients += 1;
    try {
      await actOn(c, link, cycle as CycleFacts, j, record, loaded.clients, now, out);
    } catch (e) {
      // One client's failure never stops another's.
      out.errors.push(`${link.name || c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

async function actOn(c: DashboardClient, link: OsLink, cycle: CycleFacts, j: Judgement, record: CyclePauseRecord | null, all: DashboardClient[], now: Date, out: CyclePauseRunResult): Promise<void> {
  const name = link.name || c.name;
  const span = spanOf(cycle);
  if (j.kind === "done") return;
  if (j.kind === "before") {
    // Left to the team (their answer). Said in a dry run's log; a live run stays quiet about it every 15 minutes.
    if (!out.live) out.notes.push(`${name}: ${j.delivered} of ${j.required} ${span}, reached ${j.reachedAt ? shortDay(j.reachedAt.slice(0, 10)) : "(date unknown)"}, before the switch-on: left to the team`);
    return;
  }

  if (j.kind === "reached") {
    out.reached += 1;
    if (!out.live) {
      // A dry run reads no platform: the statuses Client Health synced in the last 15 minutes are close enough to say what it would do.
      const running: CycleCampaign[] = [
        ...c.campaigns.filter((x) => x.status === "running").map((x) => ({ platform: "instantly" as const, id: x.id, int_id: null, name: x.name })),
        ...c.bisonCampaigns.filter((x) => x.status === "running").map((x) => ({ platform: "bison" as const, id: x.id, int_id: null, name: x.name })),
      ];
      const { toPause, leftRunning } = splitShared(running, sharedWith(c.id, running, all));
      out.notes.push(
        `${name}: ${j.delivered} of ${j.required} ${span}, would pause ${toPause.length ? names(toPause) : "nothing (none running)"}`
          + (leftRunning.length ? `, would leave running ${leftRunning.map((x) => `${x.name} (${x.reason})`).join(", ")}` : ""),
      );
      return;
    }
    await pauseReached(c, link, cycle, j, all, now, out);
    return;
  }

  if (j.kind !== "retry") return;
  if (!out.live) {
    out.notes.push(`${name}: still to pause from the cycle ${span}: ${names(j.list)} (the switch is off, so nothing is tried)`);
    return;
  }
  if (record) await retry(c, link, record, j.list, all, now, out);
}

async function pauseReached(c: DashboardClient, link: OsLink, cycle: CycleFacts, j: { delivered: number; required: number }, all: DashboardClient[], now: Date, out: CyclePauseRunResult): Promise<void> {
  const nowIso = now.toISOString();
  const plan = await planToggle(c.id, "pause");
  const { toPause, leftRunning } = splitShared(plan.willChange, sharedWith(c.id, plan.willChange, all));
  // One whose status couldn't be read is tried again next run, unless another client shares it: that one stays alone either way.
  const unreadAll = plan.skipped.filter((s) => UNREAD_STATUSES.has(s.campaign.status)).map((s) => s.campaign);
  const unreadShared = sharedWith(c.id, unreadAll, all);
  const unreadFirst = unreadAll.filter((x) => !unreadShared.has(keyOf(x)));
  /*
   * Written BEFORE anything is paused, and the write is the claim: the cycle's key is unique, so a second replica
   * running at the same moment gets a conflict and stops. A crash after this leaves the campaigns listed to retry.
   */
  const row = {
    os_client_id: link.id,
    cycle_start: isoDay(cycle.start),
    cycle_end: isoDay(cycle.end),
    required: j.required,
    delivered: j.delivered,
    reached_at: nowIso,
    paused: [],
    left_running: leftRunning,
    to_retry: [...toPause, ...unreadFirst].map((x): RetryCampaign => ({ platform: x.platform, id: x.id, int_id: x.int_id, name: x.name, error: null })),
    updated_at: nowIso,
  };
  const { error } = await osTable(TABLE).insert(row);
  if (error) {
    if (error.code === "23505") return; // another run has this cycle
    throw new Error(`${TABLE}: ${error.message}`);
  }
  out.leftRunning += leftRunning.length;
  const done = toPause.length ? await attempt(c.id, toPause) : { ok: [], failed: [], unread: [] };
  out.paused += done.ok.length;
  const next = afterAttempt({ paused: [] }, { ...done, unread: [...done.unread, ...unreadFirst], tried: [...toPause, ...unreadFirst] }, nowIso);
  await save(link.id, row.cycle_start, next, nowIso);
  const name = link.name || c.name;
  out.notes.push(
    `${name}: ${j.delivered} of ${j.required}, paused ${done.ok.length ? names(done.ok) : "nothing (none running)"}`
      + (leftRunning.length ? `; left running ${leftRunning.map((x) => `${x.name} (${x.reason})`).join(", ")}` : "")
      + (next.to_retry.length ? `; to retry ${names(next.to_retry)}` : ""),
  );
}

async function retry(c: DashboardClient, link: OsLink, record: CyclePauseRecord, list: RetryCampaign[], all: DashboardClient[], now: Date, out: CyclePauseRunResult): Promise<void> {
  const nowIso = now.toISOString();
  // Linked to another client since it was listed (linking goes by name): leave it running, as at the first pause.
  const { toPause, leftRunning } = splitShared(list, sharedWith(c.id, list, all));
  const done = toPause.length ? await attempt(c.id, toPause) : { ok: [], failed: [], unread: [] };
  out.paused += done.ok.length;
  out.leftRunning += leftRunning.length;
  const sharedKeys = new Set(leftRunning.map(keyOf));
  const next = afterAttempt({ paused: record.paused, to_retry: record.to_retry.filter((x) => !sharedKeys.has(keyOf(x))) }, { ...done, tried: toPause }, nowIso);
  const left = leftRunning.length ? [...record.left_running.filter((x) => !sharedKeys.has(keyOf(x))), ...leftRunning] : null;
  await save(link.id, record.cycle_start, left ? { ...next, left_running: left } : next, nowIso);
  if (done.ok.length || done.failed.length) {
    out.notes.push(`${link.name || c.name}: retried, paused ${done.ok.length ? names(done.ok) : "nothing"}${next.to_retry.length ? `; still to retry ${names(next.to_retry)}` : ""}`);
  }
}

/** Pauses exactly these, the ones still linked and sending right now (pauseListed re-reads them live). */
async function attempt(chId: string, list: CycleCampaign[]): Promise<{ ok: CycleCampaign[]; failed: { campaign: CycleCampaign; error: string }[]; unread: CycleCampaign[] }> {
  const r = await pauseListed(chId, list.map((x) => ({ platform: x.platform, id: x.id, int_id: x.int_id, name: x.name })), ACTOR);
  const asCampaign = (p: PlannedCampaign): CycleCampaign => ({ platform: p.platform, id: p.id, int_id: p.int_id, name: p.name });
  return {
    ok: r.outcomes.filter((x) => x.ok).map((x) => asCampaign(x.campaign)),
    failed: r.outcomes.filter((x) => !x.ok).map((x) => ({ campaign: asCampaign(x.campaign), error: x.error ?? "failed" })),
    unread: r.plan.skipped.filter((s) => UNREAD_STATUSES.has(s.campaign.status)).map((s) => asCampaign(s.campaign)),
  };
}

/*
 * Written after the platform answered. Tried three times: a campaign paused but not written down stays on the retry
 * list, and if a person resumed it before the next run, that run would pause it again.
 */
async function save(osClientId: string, cycleStart: string, next: Partial<Pick<CyclePauseRecord, "paused" | "to_retry" | "left_running">>, nowIso: string): Promise<void> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    const { error } = await osTable(TABLE).update({ ...next, updated_at: nowIso }).eq("os_client_id", osClientId).eq("cycle_start", cycleStart);
    if (!error) return;
    last = error.message;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw new Error(`${TABLE}: ${last}`);
}

/* ------------------------------------------------------------------ the screens --- */

/** Every linked client's cycle, as Client Health's Intros / Billing shows it, with what the pause did or would do. Reads only. */
export async function cycleProgress(env: Record<string, string | undefined> = process.env, o: { dryRunSince?: string } = {}): Promise<CycleProgressView> {
  const data = await getWeekly();
  const now = new Date(data.now);
  const [{ byCh, doubled }, records, state] = await Promise.all([
    osLinks(),
    recentRecords(now),
    osTable(STATE).select("live_since").eq("id", "default").maybeSingle().then((r) => (r.error ? null : ((r.data ?? null) as { live_since: string | null } | null))),
  ]);
  // Live: when it was switched on; not yet run live, or a dry run: this server's start (as the dry run measures).
  const liveSince = (cyclePauseLive(env) && state?.live_since) || o.dryRunSince || STARTED;
  const clients: CycleProgress[] = [];
  for (const c of data.clients) {
    const link = byCh.get(c.id);
    const cycle = cycleOf(c, now);
    const record = cycle && link ? recordForCycle(records?.get(link.id) ?? [], cycle) : null;
    const j = judge({ status: link?.status ?? null, clientPaused: c.client_paused, perLead: !!c.per_lead, cycle, record, liveSince });
    const { state, why } = progressState(j, record);
    clients.push({
      chClientId: c.id,
      osClientId: link?.id ?? null,
      analyticsClientId: link?.analyticsId ?? c.analytics_client_id ?? null,
      name: link?.name || c.name,
      lastBilling: cycle ? isoDay(cycle.start) : null,
      nextBilling: cycle ? isoDay(cycle.end) : null,
      required: cycle && cycle.required > 0 ? cycle.required : null,
      delivered: cycle ? cycle.delivered : null,
      state: link ? state : "skipped",
      why: link ? why : doubled.has(c.id) ? "two OS clients are linked to it" : "not linked to an OS client",
      pausedAt: record?.reached_at ?? null,
      paused: record?.paused ?? [],
      leftRunning: record?.left_running ?? [],
      toRetry: record?.to_retry ?? [],
      reachedAt: cycle?.reachedAt ?? null,
    });
  }
  return { live: cyclePauseLive(env), recordsReady: records !== null, clients };
}

