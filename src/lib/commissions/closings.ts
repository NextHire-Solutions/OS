/*
 * How many clients a salesperson closes, month by month (13 Oct) — pure.
 *
 * Asked for on the Commissions page: "Add a bar graph to see how [many]
 * clients [a] Salesperson is closing [by] month", with filters, beside the
 * person's card; and a Month column saying which month of service each client
 * is in.
 *
 * A CLOSING is a client the salesperson sold, dated by when it signed: the
 * first $1 charge in Stripe (the card check at sign-up), else the sign-up date
 * on the record, else the onboarding date — the same order the Performance
 * page uses for "Signed", so the two pages count the same clients in the same
 * months. Every client they sold counts, whatever became of it: a client that
 * later paused or churned was still closed. The status filter is there for
 * the other question — "how many of them are still with us".
 */

export interface Closing {
  id: string;
  name: string;
  status: string;
  /** YYYY-MM-DD the client signed. */
  date: string;
}

export type ClosingWindow = "6m" | "12m" | "ytd" | "all";
export type ClosingStatus = "all" | "active" | "paused" | "churned";

export const CLOSING_WINDOWS: ReadonlyArray<{ value: ClosingWindow; label: string }> = [
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "ytd", label: "This year" },
  { value: "all", label: "All time" },
];
export const CLOSING_STATUSES: ReadonlyArray<{ value: ClosingStatus; label: string }> = [
  { value: "all", label: "All closed" },
  { value: "active", label: "Still active" },
  { value: "paused", label: "Now paused" },
  { value: "churned", label: "Since churned" },
];

export interface ClosingMonth {
  /** YYYY-MM */
  month: string;
  /** "Oct" — and "Oct ’26" on January and on the first bar, so a year is never guessed. */
  label: string;
  long: string;
  clients: Closing[];
}

const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** The first month of a window ending in `today`'s month. */
export function windowStart(window: ClosingWindow, today: string, closings: readonly Closing[]): string {
  const thisMonth = today.slice(0, 7);
  if (window === "6m") return addMonths(thisMonth, -5);
  if (window === "12m") return addMonths(thisMonth, -11);
  if (window === "ytd") return `${today.slice(0, 4)}-01`;
  const first = closings.map((c) => c.date.slice(0, 7)).sort()[0];
  return first && first < thisMonth ? first : thisMonth;
}

/**
 * One bar per month from the window's start to this month — a month with no
 * closing is a bar of zero, not a missing bar, so a quiet month looks quiet.
 */
export function closingsByMonth(
  closings: readonly Closing[],
  window: ClosingWindow,
  status: ClosingStatus,
  today: string,
): ClosingMonth[] {
  const from = windowStart(window, today, closings);
  const to = today.slice(0, 7);
  const kept = closings.filter((c) => status === "all" || c.status === status);
  const out: ClosingMonth[] = [];
  for (let m = from, i = 0; m <= to && i < 600; m = addMonths(m, 1), i++) {
    const d = new Date(`${m}-01T00:00:00Z`);
    const short = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    out.push({
      month: m,
      label: i === 0 || m.endsWith("-01") ? `${short} ’${m.slice(2, 4)}` : short,
      long: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      clients: kept.filter((c) => c.date.slice(0, 7) === m).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
    });
  }
  return out;
}

/** A round axis top at or above the tallest bar: 1, 2, 4, 5, 10, 20 … — never a fraction of a client. */
export function axisTop(max: number): number {
  if (max <= 1) return 1;
  if (max <= 2) return 2;
  if (max <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (max <= m * p) return m * p;
  return 10 * p;
}

/*
 * Which month of service a client is in on a given day: Month 1 from its
 * first payment, Month 2 from 28 days later — the 28-day month the payouts
 * are worked out in (schedule.ts MONTH_DAYS), so "Month 2" here is the same
 * day the account manager's commission starts. Null before any payment.
 */
export function serviceMonth(firstPaid: string | null, on: string, monthDays = 28): number | null {
  if (!firstPaid) return null;
  const days = Math.round((Date.parse(`${on.slice(0, 10)}T00:00:00Z`) - Date.parse(`${firstPaid.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.floor(days / monthDays) + 1;
}
