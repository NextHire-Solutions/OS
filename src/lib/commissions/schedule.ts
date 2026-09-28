/*
 * COMMISSIONS — the arithmetic, pure and tested.
 *
 * The rules are the ones on the page ("How payouts are calculated"):
 *
 *   Month 1         the account manager earns their month-one rate (70%) of the
 *                   client's first month of payments — the first 28 days of
 *                   billing, BrokerStaffer's month (clients are billed every 14
 *                   or 28 days, so a "month" is two 14-day payments or one
 *                   28-day payment).
 *   Month 2+        every later payment earns their residual rate (15% or 25%)
 *                   for as long as the client stays active.
 *   On cancellation nothing accrues from the cancellation date.
 *   Payout runs     the 1st and the 15th. A payment is paid out on the first
 *                   run AFTER the day it was billed.
 *
 * A payment is money that came in: a paid Stripe invoice (its date and the
 * amount paid), or — only for a client with no Stripe link — an estimate on
 * the client's billing schedule, marked as such everywhere it is shown.
 *
 * All dates are calendar days (YYYY-MM-DD) in US Eastern, the business's day.
 */

export type LifecycleStatus = "onboarding" | "active" | "paused" | "churned";

export interface Payment {
  /** The day it was billed / paid, YYYY-MM-DD, Eastern. */
  date: string;
  /** Dollars. */
  amount: number;
  source: "stripe" | "estimate";
}

export interface StatusChange { from: string | null; to: string; at: string }

export interface Rates {
  /** 0.70 = 70% of the first month. */
  monthOne: number;
  /** 0.15 or 0.25 of every later payment. */
  residual: number;
}

export const DEFAULT_RATES: Rates = { monthOne: 0.7, residual: 0.15 };
export const MONTH_DAYS = 28;

const DAY = 86_400_000;
const toDay = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const fromDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => fromDay(toDay(iso) + n * DAY);

/** A timestamp as the Eastern calendar day it fell on. */
export function easternDay(at: Date | string | number): string {
  const d = at instanceof Date ? at : new Date(at);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/* ------------------------------------------------------------ payout runs --- */

/** Is this day a payout run (the 1st or the 15th)? */
export const isRunDay = (iso: string) => iso.slice(8, 10) === "01" || iso.slice(8, 10) === "15";

/** The first run on or after a day. */
export function runOnOrAfter(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (d === 1 || d === 15) return iso.slice(0, 10);
  if (d < 15) return `${y}-${String(m).padStart(2, "0")}-15`;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** The run a payment billed on `iso` is paid out on: the first run strictly after it. */
export const runForPayment = (iso: string) => runOnOrAfter(addDays(iso, 1));

/** The run after a run. */
export const nextRun = (run: string) => runOnOrAfter(addDays(run, 1));

/** The run before a run. */
export function previousRun(run: string): string {
  const [y, m, d] = run.split("-").map(Number);
  if (d === 15) return `${y}-${String(m).padStart(2, "0")}-01`;
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}-15`;
}

/* ----------------------------------------------------------------- status --- */

/**
 * The client's status on a day, from its history.
 *
 * On or after a recorded moment, the status it recorded. BEFORE the first
 * record the client was being served: history starts on 13 Sep 2026 (the
 * migration-0012 seeding), and a client already churned then was, before
 * that, a paying client — its paid invoices prove it. Treating the seeded
 * "churned" as reaching backwards would zero every commission it ever earned.
 * With no history at all, the current status is all there is.
 */
export function statusAt(changes: StatusChange[], current: LifecycleStatus, day: string): LifecycleStatus {
  if (!changes.length) return current;
  const sorted = [...changes].sort((a, b) => a.at.localeCompare(b.at));
  let last: StatusChange | null = null;
  for (const c of sorted) if (easternDay(c.at) <= day) last = c;
  return last ? (last.to as LifecycleStatus) : "active";
}

/** The day the client last churned, if it is churned now. */
export function cancellationDay(changes: StatusChange[], current: LifecycleStatus): string | null {
  if (current !== "churned") return null;
  const c = [...changes].sort((a, b) => b.at.localeCompare(a.at)).find((x) => x.to === "churned");
  return c ? easternDay(c.at) : null;
}

/* ------------------------------------------------------------ commission --- */

export interface Line {
  date: string;
  amount: number;
  source: Payment["source"];
  kind: "month1" | "residual";
  rate: number;
  commission: number;
}

/**
 * Every payment that earns commission, with its kind, rate and amount.
 *
 * Month 1 is the first 28 days from the client's first payment. A payment on
 * a day the client was churned earns nothing — "residual stops as of the
 * cancellation date". Estimated payments also earn nothing while paused: an
 * estimate is only a stand-in for a Stripe charge, and billing is paused then.
 */
export function commissionLines(
  payments: Payment[],
  changes: StatusChange[],
  current: LifecycleStatus,
  rates: Rates,
): Line[] {
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return [];
  const monthOneEnds = addDays(sorted[0].date, MONTH_DAYS);
  const out: Line[] = [];
  for (const p of sorted) {
    const s = statusAt(changes, current, p.date);
    if (s === "churned") continue;
    if (p.source === "estimate" && s === "paused") continue;
    const kind = p.date < monthOneEnds ? "month1" : "residual";
    const rate = kind === "month1" ? rates.monthOne : rates.residual;
    out.push({ date: p.date, amount: p.amount, source: p.source, kind, rate, commission: round2(p.amount * rate) });
  }
  return out;
}

/** The lines paid out on one run. */
export const linesForRun = (lines: Line[], run: string) => lines.filter((l) => runForPayment(l.date) === run);

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const sum = (lines: Line[], k: "commission" | "amount" = "commission") => round2(lines.reduce((t, l) => t + l[k], 0));

/**
 * Payments estimated on a billing schedule, for a client with no Stripe link:
 * one per billing date from the first, up to `until`, each worth this
 * client's gross per 28 days scaled to its cycle.
 */
export function estimatedPayments(
  billingDates: string[],
  grossPer28Days: number,
  cycleDays: number | null,
): Payment[] {
  // Monthly billing (cycleDays null): the gross is per month, one payment a month.
  const each = cycleDays ? round2((grossPer28Days * cycleDays) / MONTH_DAYS) : grossPer28Days;
  return billingDates.map((date) => ({ date, amount: each, source: "estimate" as const }));
}
