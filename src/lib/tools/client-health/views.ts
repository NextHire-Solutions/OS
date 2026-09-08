import { clientScore, daysUntil, nextBillingDate } from "./derive.ts";
import { TZ_SHORT_BY_VALUE, type DashboardClient } from "./types.ts";

/*
 * Row models for the Bi-Weekly and Client Success views.
 *
 * Ported from the tool's BiWeeklyTable and ClientSuccessTable so the numbers
 * are the tool's, not a second interpretation of them. Kept pure and out of
 * the components for two reasons: it is testable without a browser, and the
 * billing-cycle arithmetic below is the kind that is wrong by one for months
 * before anyone notices.
 *
 * Both take `now` explicitly. Every value here depends on today's date, so a
 * test that could not pin "today" would be untestable, and a component that
 * called `new Date()` during render would disagree with the server it
 * hydrated from.
 */

// -- Bi-Weekly ---------------------------------------------------------------

export interface BiWeeklyRow {
  client: DashboardClient;
  /** The next billing date, or null when no anchor has been set. */
  billing: Date | null;
  /** Days until billing, null when there is no billing date. */
  days: number | null;
  /** Introductions since the last billing day, precomputed by the sync worker. */
  intros: number;
  /** The cycle target — the weekly target scaled to the billing interval. */
  target: number;
  leftCycle: number;
  tzShort: string | null;
}

export type BwSortCol = "name" | "tz" | "billing" | "days" | "intros" | "leftCycle";

/**
 * The length of one billing cycle in days.
 *
 * This is what makes a monthly client's target four weeks of work rather than
 * the flat fortnightly number — get it wrong and every monthly client looks
 * like they are missing target by half.
 */
export function cycleDays(c: DashboardClient): number {
  switch (c.billing_interval) {
    case "biweekly": return 14;
    case "28-days": return 28;
    case "monthly": return 30;
    case "custom": return c.billing_interval_days ?? 14;
    default: return 14;
  }
}

export function biweeklyRows(clients: DashboardClient[], now: Date): BiWeeklyRow[] {
  return clients.map((c) => {
    const anchor = c.billing_anchor_date ?? c.start_date;
    const billing = nextBillingDate(anchor, c.billing_interval, now, c.billing_interval_days);
    const intros = c.intros_since_last_billing;
    const target = Math.max(1, Math.round((c.weekly_target * cycleDays(c)) / 7));
    return {
      client: c,
      billing,
      days: billing ? daysUntil(billing, now) : null,
      intros,
      target,
      leftCycle: Math.max(0, target - intros),
      tzShort: c.time_zone ? (TZ_SHORT_BY_VALUE[c.time_zone] ?? c.time_zone) : null,
    };
  });
}

/**
 * Default order: soonest billing first, unset dates last.
 *
 * Which is the useful default — the screen exists to answer "who bills next".
 */
function bwDefaultCmp(a: BiWeeklyRow, b: BiWeeklyRow): number {
  if (a.days === null && b.days === null) return a.client.name.localeCompare(b.client.name);
  if (a.days === null) return 1;
  if (b.days === null) return -1;
  return a.days - b.days;
}

export function sortBiWeekly(
  rows: BiWeeklyRow[],
  sort: { col: BwSortCol; dir: "desc" | "asc" } | null,
): BiWeeklyRow[] {
  if (!sort) return [...rows].sort(bwDefaultCmp);
  const mul = sort.dir === "desc" ? 1 : -1;
  const byName = (a: BiWeeklyRow, b: BiWeeklyRow) => a.client.name.localeCompare(b.client.name);
  return [...rows].sort((a, b) => {
    switch (sort.col) {
      // localeCompare is naturally ascending — negate so "desc" means Z→A.
      case "name": return -mul * byName(a, b);
      case "billing": {
        if (!a.billing && !b.billing) return byName(a, b);
        if (!a.billing) return 1;
        if (!b.billing) return -1;
        return mul * (b.billing.getTime() - a.billing.getTime());
      }
      case "days": {
        if (a.days === null && b.days === null) return byName(a, b);
        if (a.days === null) return 1;
        if (b.days === null) return -1;
        return mul * (b.days - a.days);
      }
      case "intros": return mul * (b.intros - a.intros);
      case "leftCycle": return mul * (b.leftCycle - a.leftCycle);
      case "tz": {
        const av = a.tzShort ?? "", bv = b.tzShort ?? "";
        if (!av && !bv) return byName(a, b);
        if (!av) return 1;
        if (!bv) return -1;
        return -mul * av.localeCompare(bv);
      }
      default: return 0;
    }
  });
}

// -- Client Success ----------------------------------------------------------

export interface SuccessRow {
  client: DashboardClient;
  hiredTotal: number;
  lastHireAt: string | null;
  /** 0–10, or null for a client too new to score. */
  score: number | null;
  tzShort: string | null;
}

export type CsSortCol =
  | "name" | "plan" | "score" | "tz" | "launch" | "portal"
  | "stage" | "hired" | "lastHire" | "dnc" | "agents";

export function successRows(clients: DashboardClient[], now: Date): SuccessRow[] {
  return clients.map((c) => {
    let lastHireMs = 0;
    let hiredTotal = 0;
    for (const m of Object.values(c.metricsByWeek)) {
      if (m.last_hired_at) {
        const t = new Date(m.last_hired_at).getTime();
        if (Number.isFinite(t) && t > lastHireMs) lastHireMs = t;
      }
      hiredTotal += m.hired_corofy ?? 0;
    }
    return {
      client: c,
      hiredTotal,
      lastHireAt: lastHireMs > 0 ? new Date(lastHireMs).toISOString() : null,
      score: clientScore(c.metricsByWeek, c.weekly_target, now).score,
      tzShort: c.time_zone ? (TZ_SHORT_BY_VALUE[c.time_zone] ?? c.time_zone) : null,
    };
  });
}

export function sortSuccess(
  rows: SuccessRow[],
  sort: { col: CsSortCol; dir: "desc" | "asc" } | null,
): SuccessRow[] {
  const byName = (a: SuccessRow, b: SuccessRow) => a.client.name.localeCompare(b.client.name);
  if (!sort) return [...rows].sort(byName);
  const mul = sort.dir === "desc" ? 1 : -1;

  // Returns 0 when both sides are missing, so the `|| byName` fallback fires.
  const strCmp = (av: string | null | undefined, bv: string | null | undefined) => {
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return -mul * av.localeCompare(bv);
  };
  const numCmp = (av: number, bv: number) => mul * (bv - av);
  const dateCmp = (av: string | null | undefined, bv: string | null | undefined) => {
    const at = av ? new Date(av).getTime() : 0;
    const bt = bv ? new Date(bv).getTime() : 0;
    if (at === 0 && bt === 0) return 0;
    if (at === 0) return 1;
    if (bt === 0) return -1;
    return mul * (bt - at);
  };

  return [...rows].sort((a, b) => {
    switch (sort.col) {
      case "name": return -mul * byName(a, b);
      case "plan": return -mul * a.client.plan.localeCompare(b.client.plan) || byName(a, b);
      case "score": {
        // A new client has no score. It sinks to the bottom either way rather
        // than sorting as a zero, which would read as "scored badly".
        if (a.score === null && b.score === null) return byName(a, b);
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return mul * (b.score - a.score) || byName(a, b);
      }
      case "tz": return strCmp(a.tzShort, b.tzShort) || byName(a, b);
      case "launch": return dateCmp(a.client.start_date, b.client.start_date) || byName(a, b);
      case "portal": return dateCmp(a.client.last_lead_activity_at, b.client.last_lead_activity_at) || byName(a, b);
      case "stage": return numCmp(a.client.stagnant_intros_count, b.client.stagnant_intros_count) || byName(a, b);
      case "hired": return numCmp(a.hiredTotal, b.hiredTotal) || byName(a, b);
      case "lastHire": return dateCmp(a.lastHireAt, b.lastHireAt) || byName(a, b);
      case "dnc": return numCmp(a.client.dnc_count, b.client.dnc_count) || byName(a, b);
      case "agents": return numCmp(a.client.agents_count, b.client.agents_count) || byName(a, b);
      default: return 0;
    }
  });
}

/** Score colour cutoffs, kept in one place so the team can retune them. */
export function scoreTone(s: number): "good" | "mid" | "low" {
  return s >= 8 ? "good" : s >= 5 ? "mid" : "low";
}

// -- Shared formatting -------------------------------------------------------

/** "5 min ago" / "2h ago" / "3d ago" / "—". The tool's own wording. */
export function humanizeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "Yesterday";
  if (d < 30) return `${d}d ago`;
  const months = Math.floor(d / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** MM/DD/YYYY in UTC — dates here are calendar days, not instants. */
export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return fmtDateUTC(new Date(t));
}

export function fmtDateUTC(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}
