/*
 * BILLING-CYCLE AUTO-PAUSE: the rules (20 Nov 2026; BrokerStaffer's "Campaign Activation, Deactivation & Billing
 * Cycle Management" request, Section 2, and the team's answers pasted the same day).
 *
 *   A client's target is per billing cycle, shared by all its campaigns: the "due" figure of Client Health's
 *   Intros / Billing column (cycle.required: the cycle's target plus any shortfall carried in), over the cycle dates
 *   that column shows (Stripe's charge dates, or the record's). When the cycle's introductions reach it, every
 *   campaign of the client that is sending pauses.
 *
 *   Nothing restarts by itself, not even in a new cycle: a person resumes them (Play on Client Health, or Resume on
 *   the campaign). It acts once per cycle, so a campaign a person resumes after that keeps running for the rest of
 *   the cycle; the next time a target is reached, in a later cycle, the client's campaigns pause again.
 *
 *   Left alone: a client that isn't Active (or is marked paused), a client billed per lead (Lead caps pauses those,
 *   by leads), a client with no target or no billing date, and a campaign linked to another client too, because
 *   pausing it would stop that client's emails on this client's target.
 *
 * Only clients that reach their due AFTER the pause is switched on (the team, 20 Nov: "only pause campaigns for
 * clients who reach their target after the automation is enabled. I'll manually review and handle any clients who have
 * already reached their billing cycle target"). When a client reached it is the time of the introduction that made the
 * cycle's count reach its due, counted exactly as Client Health counts them; one reached before is left to the team.
 *
 * Off by default: without OS_CYCLE_PAUSE=1 the sweep only logs what it would do. It sends no notifications (the
 * team's answer: billing-cycle alerts are not wanted). Pure: no database, no platform, no clock.
 */

import { dayNumber } from "./billing.ts";

export type Platform = "instantly" | "bison";

export interface CycleCampaign {
  platform: Platform;
  id: string;
  /** EmailBison's integer id: its API accepts only this. Null for Instantly. */
  int_id: number | null;
  name: string;
}

export interface PausedCampaign extends CycleCampaign {
  paused_at: string;
}

export interface LeftRunning extends CycleCampaign {
  reason: string;
}

export interface RetryCampaign extends CycleCampaign {
  /** Null when it was written down but not tried yet (the run stopped in between). */
  error: string | null;
  /** How many runs have tried it. After MAX_TRIES it is left, still listed, so the screens say it never paused. */
  attempts?: number;
}

/** Tries before a campaign that won't pause is given up on: two hours of 15-minute runs. Each try writes the toggle log. */
export const MAX_TRIES = 8;

/** One row of os_cycle_pauses (migration 0054): a client whose cycle reached its target while the sweep was live. */
export interface CyclePauseRecord {
  os_client_id: string;
  /** The cycle, as Client Health shows it: from the last billing date to the next one (YYYY-MM-DD). */
  cycle_start: string;
  cycle_end: string;
  required: number;
  delivered: number;
  reached_at: string;
  paused: PausedCampaign[];
  left_running: LeftRunning[];
  /** Still to pause: tried and failed, or not tried yet. Each run tries these again, until the cycle ends. */
  to_retry: RetryCampaign[];
  updated_at: string;
}

export interface CycleFacts {
  start: Date;
  end: Date;
  target: number;
  required: number;
  delivered: number;
  /** When the cycle's count reached its due (reachedAt below); null when it hasn't, or it couldn't be told. */
  reachedAt?: string | null;
}

/**
 * The introduction that made this cycle's count reach its due: the ceil(required)-th of the introductions counted in
 * the cycle, in the order they were made. Counted as billing.ts counts a cycle: introductions on the days after the
 * last billing date up to the next one, and not after `asOf`. Null when the count is still short of the due.
 */
export function reachedAt(introDates: readonly string[], cycle: Pick<CycleFacts, "start" | "end">, required: number, asOf: Date): string | null {
  const lo = dayNumber(cycle.start);
  const hi = Math.min(dayNumber(cycle.end), dayNumber(asOf));
  const counted = introDates
    .filter((d) => { const n = dayNumber(d); return Number.isFinite(n) && n > lo && n <= hi; })
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const k = Math.ceil(required);
  if (k <= 0 || counted.length < k) return null;
  return counted[k - 1];
}

export interface JudgeInput {
  /** The master record's status (os_clients.status). */
  status: string | null;
  /** Client Health's "service temporarily paused" flag. */
  clientPaused: boolean;
  /** Billed per lead: Lead caps owns its pausing. */
  perLead: boolean;
  /** Client Health's billing snapshot of the cycle in progress; null when it has no billing date. */
  cycle: CycleFacts | null;
  /** This cycle's record, if the sweep has already acted on it (recordForCycle). */
  record: CyclePauseRecord | null;
  /**
   * When the pause was switched on. A client that reached its due before this is left to the team. Absent: no such
   * limit (the rules on their own).
   */
  liveSince?: string | null;
}

export type Judgement =
  | { kind: "skip"; reason: string }
  | { kind: "below"; delivered: number; required: number }
  /** At or past the target and not acted on yet this cycle: pause what is sending. */
  | { kind: "reached"; delivered: number; required: number }
  /** Acted on this cycle, with campaigns still to pause. */
  | { kind: "retry"; list: RetryCampaign[] }
  /** Acted on this cycle; nothing more to do, whatever a person has resumed since. */
  | { kind: "done" }
  /** At its due already when the pause was switched on: left to the team (their answer, 20 Nov). */
  | { kind: "before"; delivered: number; required: number; reachedAt: string | null };

export const ACTOR = "billing cycle target";

export function cyclePauseLive(env: Record<string, string | undefined>): boolean {
  return env.OS_CYCLE_PAUSE === "1";
}

/** The sweep runs only on Railway with the OS database configured: never on a laptop, live or not. */
export function cyclePauseScheduled(env: Record<string, string | undefined>): boolean {
  return !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT) && !!env.MASTER_INBOX_SUPABASE_URL;
}

/** A UTC-midnight cycle boundary as the date it names (billing.ts works in whole UTC days). */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export const keyOf = (c: { platform: string; id: string }): string => `${c.platform}:${c.id}`;

/**
 * The record for the cycle in progress: the one made DURING it, i.e. reached after its last billing date and by its
 * next (billing.ts: a cycle is (start, end] in whole UTC days). By when it acted, not by the dates stored: a cycle
 * whose dates move (Stripe's charge date changed) is still the cycle already acted on, so a campaign a person resumed
 * isn't paused again; and a record from the cycle before never covers this one, even when the dates moved earlier.
 */
export function recordForCycle(records: CyclePauseRecord[], cycle: Pick<CycleFacts, "start" | "end">): CyclePauseRecord | null {
  const start = isoDay(cycle.start);
  const end = isoDay(cycle.end);
  return records.find((r) => {
    const day = String(r.reached_at ?? "").slice(0, 10);
    return day > start && day <= end;
  }) ?? null;
}

/** The campaigns still worth trying: not given up on yet. */
export const retriable = (list: RetryCampaign[]): RetryCampaign[] => list.filter((c) => (c.attempts ?? 0) < MAX_TRIES);

export function judge(i: JudgeInput): Judgement {
  const status = (i.status ?? "").trim().toLowerCase();
  if (status !== "active") return { kind: "skip", reason: status ? `status is ${status}` : "no status on its record" };
  if (i.clientPaused) return { kind: "skip", reason: "marked paused on Client Health" };
  if (i.perLead) return { kind: "skip", reason: "billed per lead: Lead caps pauses it" };
  if (!i.cycle) return { kind: "skip", reason: "no billing date" };
  if (i.cycle.target <= 0 || i.cycle.required <= 0) return { kind: "skip", reason: "no target set" };
  const { delivered, required } = i.cycle;
  if (delivered < required) return { kind: "below", delivered, required };
  if (i.record) {
    const list = retriable(i.record.to_retry);
    return list.length ? { kind: "retry", list } : { kind: "done" };
  }
  if (i.liveSince) {
    // When it reached its due can't be told (an introduction without a date): treated as before, so nothing is paused on a guess.
    const at = i.cycle.reachedAt ?? null;
    if (!at || Date.parse(at) < Date.parse(i.liveSince)) return { kind: "before", delivered, required, reachedAt: at };
  }
  return { kind: "reached", delivered, required };
}

export interface LinkedClient {
  id: string;
  name: string;
  instantly_campaign_ids: string[] | null;
  bison_campaign_ids: string[] | null;
}

/** Which of these campaigns another client is linked to as well, and which clients. Linking goes by name, so it happens. */
export function sharedWith(clientId: string, list: { platform: Platform; id: string }[], clients: LinkedClient[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of list) {
    const also = clients
      .filter((o) => o.id !== clientId && (c.platform === "bison" ? o.bison_campaign_ids : o.instantly_campaign_ids)?.includes(c.id))
      .map((o) => o.name);
    if (also.length) out.set(keyOf(c), also);
  }
  return out;
}

/** The sending campaigns split into those to pause and those left running because another client shares them. */
export function splitShared<T extends CycleCampaign>(sending: T[], shared: Map<string, string[]>): { toPause: T[]; leftRunning: LeftRunning[] } {
  const toPause: T[] = [];
  const leftRunning: LeftRunning[] = [];
  for (const c of sending) {
    const others = shared.get(keyOf(c));
    if (others?.length) leftRunning.push({ platform: c.platform, id: c.id, int_id: c.int_id, name: c.name, reason: `also linked to ${others.join(", ")}` });
    else toPause.push(c);
  }
  return { toPause, leftRunning };
}

/** Statuses a pause can't decide on yet: the platform couldn't be read. Those are tried again. */
export const UNREAD_STATUSES = new Set(["unreachable", "unknown"]);

/**
 * After a pause attempt: what joins `paused`, and what stays to retry. `tried` is what was asked; `ok` the ones the
 * platform confirmed; `failed` the errors; `unread` the ones whose status couldn't be read, so nothing was decided.
 * Anything asked that is none of these was found already paused, finished or gone: nothing left to do for it.
 */
export function afterAttempt(
  prev: Pick<CyclePauseRecord, "paused"> & { to_retry?: RetryCampaign[] },
  o: { ok: CycleCampaign[]; failed: { campaign: CycleCampaign; error: string }[]; unread: CycleCampaign[]; tried?: CycleCampaign[] },
  nowIso: string,
): Pick<CyclePauseRecord, "paused" | "to_retry"> {
  const paused = new Map(prev.paused.map((c) => [keyOf(c), c]));
  for (const c of o.ok) paused.set(keyOf(c), { platform: c.platform, id: c.id, int_id: c.int_id, name: c.name, paused_at: nowIso });
  // Each try counts; one given up on before stays listed as it was, so the screens can say it never paused.
  const before = new Map((prev.to_retry ?? []).map((c) => [keyOf(c), c]));
  const triedKeys = new Set((o.tried ?? []).map(keyOf));
  const tries = (c: CycleCampaign) => (before.get(keyOf(c))?.attempts ?? 0) + 1;
  const retry = new Map<string, RetryCampaign>();
  for (const f of o.failed) retry.set(keyOf(f.campaign), { ...pick(f.campaign), error: f.error.slice(0, 300), attempts: tries(f.campaign) });
  for (const c of o.unread) if (!retry.has(keyOf(c))) retry.set(keyOf(c), { ...pick(c), error: "its status couldn't be read", attempts: tries(c) });
  for (const [k, c] of before) if (!triedKeys.has(k) && !retry.has(k) && !paused.has(k)) retry.set(k, c);
  return { paused: [...paused.values()], to_retry: [...retry.values()] };
}

const pick = (c: CycleCampaign): CycleCampaign => ({ platform: c.platform, id: c.id, int_id: c.int_id ?? null, name: c.name });

/* ---------------------------------------------------------------- the display --- */

export type ProgressState = "below" | "reached" | "paused" | "skipped" | "before";

/** One client's cycle as Campaign Management and Client Health show it. */
export interface CycleProgress {
  chClientId: string;
  osClientId: string | null;
  analyticsClientId: string | null;
  name: string;
  /**
   * The last billing date and the next one: the cycle as Intros / Billing shows it. The next billing date is in the
   * cycle (billing.ts: an introduction made on a billing date counts toward the cycle billed that day).
   */
  lastBilling: string | null;
  nextBilling: string | null;
  required: number | null;
  delivered: number | null;
  state: ProgressState;
  /** Why it is left alone, for "skipped". */
  why: string | null;
  /** When it reached its due, for "before" (and "reached"). */
  reachedAt?: string | null;
  pausedAt: string | null;
  paused: PausedCampaign[];
  leftRunning: LeftRunning[];
  toRetry: RetryCampaign[];
}

export interface CycleProgressView {
  live: boolean;
  /** False before migration 0054: nothing has been recorded yet. */
  recordsReady: boolean;
  clients: CycleProgress[];
}

/** The state a client's cycle is shown in: its record wins once it has one, else what judge() says now. */
export function progressState(j: Judgement, record: CyclePauseRecord | null): { state: ProgressState; why: string | null } {
  if (record) return { state: "paused", why: null };
  if (j.kind === "skip") return { state: "skipped", why: j.reason };
  if (j.kind === "below") return { state: "below", why: null };
  if (j.kind === "before") return { state: "before", why: null };
  return { state: "reached", why: null };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 3" from 2026-11-03. */
export const shortDay = (iso: string): string => {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};

export const names = (list: { name: string }[]): string => {
  const shown = list.slice(0, 4).map((c) => c.name);
  return list.length > 4 ? `${shown.join(", ")} and ${list.length - 4} more` : shown.join(", ");
};
