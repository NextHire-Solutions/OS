/*
 * COMMISSIONS — the arithmetic, pure and tested.
 *
 * The rules (Eddy, 1 Oct — replacing the 70% Month 1 / 15–25% residual ones):
 *
 *   Every payment   earns a flat rate of what is left after Stripe's fee
 *                   (2.9% + $0.30 per successful card charge): the client's
 *                   salesperson 20% or 10% (set per salesperson) from the
 *                   first payment; its account manager 5%, but ONLY from
 *                   Month 2 — nothing on the client's first 28 days of
 *                   billing. No special first-month rate.
 *   Active only     only clients that are active now are paid (and shown).
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
  /** 0.20 = 20% of every payment, after Stripe's fee. */
  rate: number;
}

/** A salesperson earns one of these (Eddy, 1 Oct); 20% until someone picks. */
export const SALESPERSON_RATES = [0.2, 0.1];
export const DEFAULT_SALESPERSON_RATE = 0.2;
/** Every account manager, on every client. */
export const ACCOUNT_MANAGER_RATE = 0.05;

/** A stored salesperson rate, or the default when it is not one of the allowed ones (the old 15% / 25%). */
export const salespersonRate = (stored: number | null | undefined) =>
  SALESPERSON_RATES.includes(Number(stored)) ? Number(stored) : DEFAULT_SALESPERSON_RATE;

/** Stripe's fee on one successful card charge: 2.9% + $0.30. */
export const stripeFee = (amount: number) => (amount > 0 ? round2(amount * 0.029 + 0.3) : 0);

/**
 * A gross per 28 days, net of Stripe's fee: one charge per billing cycle
 * (two a month for a 14-day client, one for 28-day or monthly billing).
 */
export function netPer28(gross: number, cycleDays: number | null): number {
  const charges = cycleDays && cycleDays > 0 ? MONTH_DAYS / cycleDays : 1;
  const each = gross / charges;
  return round2(gross - stripeFee(each) * charges);
}

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
  /** The payment, before Stripe's fee. */
  amount: number;
  fee: number;
  /** What the commission is a percentage of. */
  net: number;
  source: Payment["source"];
  rate: number;
  commission: number;
}

/** The first day after a client's Month 1: 28 days from its first payment. */
export function monthTwoStarts(payments: Payment[]): string | null {
  const first = payments.reduce<string | null>((m, p) => (m === null || p.date < m ? p.date : m), null);
  return first ? addDays(first, MONTH_DAYS) : null;
}

/**
 * Every payment that earns commission, with its fee, rate and amount.
 *
 * `fromMonthTwo` (account managers): payments in the client's first 28 days
 * of billing earn nothing.
 *
 * A payment on a day the client was churned earns nothing — "nothing accrues
 * from the cancellation date". Estimated payments also earn nothing while
 * paused: an estimate is only a stand-in for a Stripe charge, and billing is
 * paused then.
 */
export function commissionLines(
  payments: Payment[],
  changes: StatusChange[],
  current: LifecycleStatus,
  rate: number,
  opts: { fromMonthTwo?: boolean } = {},
): Line[] {
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const monthTwo = monthTwoStarts(sorted);
  const out: Line[] = [];
  for (const p of sorted) {
    if (opts.fromMonthTwo && monthTwo && p.date < monthTwo) continue;
    const s = statusAt(changes, current, p.date);
    if (s === "churned") continue;
    if (p.source === "estimate" && s === "paused") continue;
    const fee = stripeFee(p.amount);
    const net = round2(p.amount - fee);
    out.push({ date: p.date, amount: p.amount, fee, net, source: p.source, rate, commission: round2(net * rate) });
  }
  return out;
}

/** The lines paid out on one run. */
export const linesForRun = (lines: Line[], run: string) => lines.filter((l) => runForPayment(l.date) === run);

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const sum = (lines: Line[], k: "commission" | "amount" | "net" = "commission") => round2(lines.reduce((t, l) => t + l[k], 0));

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
