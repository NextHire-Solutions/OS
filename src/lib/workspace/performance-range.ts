/*
 * The Performance page's date filter and the tiles that follow it — pure.
 *
 * From the client's wireframe (11 Oct) and its "Spec for dev":
 *
 *   DATE FILTER   This month · Last 30 days · Last 90 days · YTD (default) ·
 *                 All time · Custom range.
 *   COMPARE       the previous period of the same length (default), or the
 *                 same period last year.
 *   SCOPE         only tiles tagged RANGE recalculate. TODAY tiles are live as
 *                 of now and ALL TIME tiles ignore the filter.
 *
 * Everything here works on calendar days as YYYY-MM-DD strings — the
 * business's days (Eastern for money, the dates entered on a client's record
 * for clients) — so there is no clock and no time zone inside the arithmetic,
 * and the same inputs always give the same tiles. The page computes its tiles
 * in the browser from one payload of facts, so changing the range is instant
 * and cannot disagree with the server about what "last 30 days" means.
 */

export type RangePreset = "month" | "30d" | "90d" | "ytd" | "all" | "custom";
export type CompareMode = "previous" | "year";

export const RANGE_PRESETS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "month", label: "This month" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All time" },
];
export const DEFAULT_PRESET: RangePreset = "ytd";

export interface DayRange {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const t = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// A real calendar day: 31 February parses (the engine rolls it into March), so
// the date has to survive a round trip to count.
export const isDay = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(t(v)) && iso(t(v)) === v;

export function addDays(day: string, n: number): string {
  return iso(t(day) + n * DAY_MS);
}

/** Days in a range, both ends included. */
export function rangeDays(r: DayRange): number {
  return Math.round((t(r.to) - t(r.from)) / DAY_MS) + 1;
}

/*
 * The range a preset means, ending today.
 *
 * `earliest` is the first day anything happened (the first charge, the first
 * client) — where "All time" starts. A custom range is taken as given, with
 * its ends swapped if they arrive the wrong way round and its end held to
 * today: nothing has been collected tomorrow.
 */
export function resolveRange(preset: RangePreset, today: string, earliest: string, custom?: Partial<DayRange> | null): DayRange {
  if (preset === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (preset === "30d") return { from: addDays(today, -29), to: today };
  if (preset === "90d") return { from: addDays(today, -89), to: today };
  if (preset === "all") return { from: earliest <= today ? earliest : today, to: today };
  if (preset === "custom" && isDay(custom?.from) && isDay(custom?.to)) {
    let [from, to] = custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from];
    if (to > today) to = today;
    if (from > to) from = to;
    return { from, to };
  }
  return { from: `${today.slice(0, 4)}-01-01`, to: today }; // ytd, and a custom range not yet filled in
}

/** One calendar year earlier; 29 Feb falls back to 28 Feb. */
function yearBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const candidate = `${y - 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isDay(candidate) ? candidate : `${y - 1}-02-28`;
}

/*
 * What the range is compared with.
 *
 *   previous   the same number of days, ending the day before the range starts
 *   year       the same dates one year earlier
 */
export function compareRange(r: DayRange, mode: CompareMode): DayRange {
  if (mode === "year") return { from: yearBefore(r.from), to: yearBefore(r.to) };
  const days = rangeDays(r);
  const to = addDays(r.from, -1);
  return { from: addDays(to, -(days - 1)), to };
}

const inRange = (day: string | null | undefined, r: DayRange): boolean => !!day && day.slice(0, 10) >= r.from && day.slice(0, 10) <= r.to;

/** One client, as the tiles need it. Dates are YYYY-MM-DD or null. */
export interface RangeClient {
  id: string;
  name: string;
  status: string;
  /** Signed: the first $1 Stripe charge, else the sign-up date on the record, else the onboarding date. */
  signed: string | null;
  /** Added to the client base: the onboarding date, else the sign-up date (the movement table's rule). */
  added: string | null;
  /** Churn date — only while the client IS churned (a reactivated client's old date is not a churn). */
  churned: string | null;
  /** Months of service paid for through Stripe; null when Stripe has no subscription payment for them. */
  monthsPaid: number | null;
}

export interface RangeTiles {
  range: DayRange;
  compare: DayRange;
  /** Clients signed in the range, and where those same clients stand today. */
  signed: number;
  signedActive: number;
  signedPaused: number;
  signedChurned: number;
  signedOther: number;
  signedNames: string[];
  added: number;
  addedNames: string[];
  churned: number;
  churnedNames: string[];
  /** Collected in the range, and in the compare period; null when Stripe could not be read. */
  revenue: number | null;
  revenueCompare: number | null;
  /** (revenue − compare) ÷ compare, as a percentage to one decimal; null when there is nothing to divide by. */
  growthPct: number | null;
  /** Average months paid, across clients signed in the range that Stripe has payments for. */
  lifespanMonths: number | null;
  lifespanClients: number;
  /** Average revenue per account × lifespan; null when either is unknown. */
  ltv: number | null;
}

export function sumDays(byDay: ReadonlyArray<readonly [string, number]>, r: DayRange): number {
  let total = 0;
  for (const [day, amount] of byDay) if (day >= r.from && day <= r.to) total += amount;
  return Math.round(total * 100) / 100;
}

const names = (list: RangeClient[]) => list.map((c) => c.name).sort((a, b) => a.localeCompare(b));

/**
 * The RANGE tiles.
 *
 * `revenueByDay` is null when Stripe could not be read: revenue, growth and
 * LTV are then unknown, never zero. `arpa` is the TODAY tile's figure (MRR ÷
 * active clients), handed in so LTV uses the number on the screen.
 */
export function rangeTiles(
  clients: readonly RangeClient[],
  revenueByDay: ReadonlyArray<readonly [string, number]> | null,
  range: DayRange,
  compare: DayRange,
  arpa: number | null,
): RangeTiles {
  const signed = clients.filter((c) => inRange(c.signed, range));
  const added = clients.filter((c) => inRange(c.added, range));
  const churned = clients.filter((c) => inRange(c.churned, range));
  const revenue = revenueByDay ? sumDays(revenueByDay, range) : null;
  const revenueCompare = revenueByDay ? sumDays(revenueByDay, compare) : null;
  const paying = signed.filter((c) => typeof c.monthsPaid === "number");
  const lifespanMonths = paying.length
    ? Math.round((paying.reduce((s, c) => s + (c.monthsPaid as number), 0) / paying.length) * 10) / 10
    : null;
  const at = (status: string) => signed.filter((c) => c.status === status).length;
  return {
    range,
    compare,
    signed: signed.length,
    signedActive: at("active"),
    signedPaused: at("paused"),
    signedChurned: at("churned"),
    signedOther: signed.length - at("active") - at("paused") - at("churned"),
    signedNames: names(signed),
    added: added.length,
    addedNames: names(added),
    churned: churned.length,
    churnedNames: names(churned),
    revenue,
    revenueCompare,
    growthPct: revenue !== null && revenueCompare !== null && revenueCompare > 0
      ? Math.round(((revenue - revenueCompare) / revenueCompare) * 1000) / 10
      : null,
    lifespanMonths,
    lifespanClients: paying.length,
    ltv: arpa !== null && lifespanMonths !== null ? Math.round(arpa * lifespanMonths) : null,
  };
}

/** MRR ÷ active clients — the monthly revenue per account. Null with no active clients. */
export function revenuePerAccount(mrr: number | null, activeClients: number): number | null {
  if (mrr === null || activeClients <= 0) return null;
  return Math.round((mrr / activeClients) * 100) / 100;
}

const short = (day: string, withYear: boolean) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });

/** "Jan 1 to Oct 11" — the year is given when the two ends are in different years, or not this year. */
export function rangeLabel(r: DayRange, today: string): string {
  const year = r.from.slice(0, 4) !== r.to.slice(0, 4) || r.to.slice(0, 4) !== today.slice(0, 4);
  return r.from === r.to ? short(r.from, year) : `${short(r.from, year)} to ${short(r.to, year)}`;
}
