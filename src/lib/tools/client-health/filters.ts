import { daysUntil, nextBillingDate } from "./derive.ts";
import type { WeeklyRow } from "./summarize.ts";
import { TIME_ZONES } from "./types.ts";

/*
 * The Weekly view's filters — a direct port of the tool's own switch statement.
 *
 * Kept out of the component so it can be tested without a browser. A pill
 * labelled "At Risk" that selects a slightly different set than the live tool's
 * is worse than no pill at all: the reader would trust it and act on it.
 *
 * The subtlety worth naming: `hidden` and `client_paused` clients are excluded
 * from EVERY filter except their own tab. That default-exclude is why the
 * headline count is 36 and not 48, and dropping it would silently re-admit
 * twelve churned and paused clients into every number on the screen.
 *
 * The tool applies these in a fixed order — subset, then search, then the
 * three selects, then the date range — and that order is reproduced here. It
 * matters only for cost, not for the result: the cheap predicates run first so
 * the expensive billing-date arithmetic sees the smallest list.
 */

export type Filter =
  | "all" | "risk" | "ok" | "done"
  | "active" | "paused" | "inactive"
  | "client-paused" | "hidden";

/** "all", or a number of days — the next billing date must fall inside it. */
export type BillingWindow = "all" | "7" | "14" | "30";

/*
 * The tool's nine filters, in its order, with its own labels.
 *
 * The last two are tabs rather than filters: hidden and client-paused clients
 * are excluded from every other view, so these are the only way to reach them.
 * Leaving them out would make churned clients unreachable from the workspace.
 *
 * "Campaign Paused" and "Client Paused" are different things and both are kept
 * — the first means the campaign stopped running, the second that somebody
 * paused the client. Collapsing them would lose a distinction the tool draws,
 * and its rename pass made the labels say which is which.
 */
export const FILTER_TABS: { id: Filter; label: string; cls?: string; title: string }[] = [
  { id: "all", label: "All", title: "Every active client" },
  { id: "risk", label: "At Risk", cls: "f-risk", title: "Below half their weekly target" },
  { id: "ok", label: "On Track", cls: "f-ok", title: "Between half target and full" },
  { id: "done", label: "Done", cls: "f-ok", title: "Clients who reached their weekly intro target" },
  { id: "active", label: "Active", title: "Clients with at least one running campaign" },
  { id: "paused", label: "Campaign Paused", title: "Clients whose campaigns are paused or finished (no running)" },
  { id: "inactive", label: "Inactive", title: "Clients with no campaign launched yet" },
  { id: "client-paused", label: "Client Paused", title: "Clients you have manually paused" },
  { id: "hidden", label: "Clients Churned", title: "Only churned clients" },
];

/** The plan select, in the tool's order. */
export const PLAN_OPTIONS: { id: string; label: string }[] = [
  { id: "all", label: "All Plans" },
  { id: "minimum", label: "Minimum" },
  { id: "production", label: "Production" },
  { id: "partner", label: "Partner" },
];

/** The time-zone select — "All", then the seven zones by short code. */
export const TZ_OPTIONS: { id: string; label: string }[] = [
  { id: "all", label: "All Time Zones" },
  ...TIME_ZONES.map((tz) => ({ id: tz.value, label: tz.short })),
];

/** The billing-window select. */
export const BILLING_WINDOW_OPTIONS: { id: BillingWindow; label: string }[] = [
  { id: "all", label: "Any Billing" },
  { id: "7", label: "Next 7 days" },
  { id: "14", label: "Next 14 days" },
  { id: "30", label: "Next 30 days" },
];

export interface FilterState {
  search: string;
  filter: Filter;
  /** A plan id, or "all". Orthogonal to `filter`. */
  plan: string;
  /** An IANA time-zone string, or "all". */
  tz?: string;
  /** Only clients whose NEXT billing date falls within this many days. */
  billingWindow?: BillingWindow;
  /** Inclusive bounds on `start_date`, as YYYY-MM-DD. */
  dateFrom?: string | null;
  dateTo?: string | null;
}

/**
 * Applies every filter, in the tool's order.
 *
 * `now` is a parameter rather than a call to `new Date()` for the reason it
 * always is here: the billing window depends on today's date, and reading the
 * clock during render makes the server and the browser disagree.
 */
export function applyFilters(rows: WeeklyRow[], o: FilterState, now: Date = new Date()): WeeklyRow[] {
  let list = rows.filter(({ client: c }) => {
    if (o.filter === "hidden") return c.hidden;
    if (o.filter === "client-paused") return c.client_paused;
    return !c.hidden && !c.client_paused;
  });

  list = list.filter(({ client: c, derived: d }) => {
    const all = [...c.campaigns, ...c.bisonCampaigns];
    const hasRunning = all.some((x) => x.status === "running");
    const hasLaunched = all.some((x) => x.status === "paused" || x.status === "finished");
    switch (o.filter) {
      case "risk": return d.status === "risk";
      case "ok": return d.status === "ok";
      case "done": return d.metTarget;
      case "active": return hasRunning;
      // Launched but not running now — matches the "Campaign Paused" badge.
      case "paused": return !hasRunning && hasLaunched;
      // Never launched — matches the "Not Active" badge.
      case "inactive": return !hasRunning && !hasLaunched;
      default: return true;
    }
  });

  const q = o.search.trim().toLowerCase();
  if (q) list = list.filter(({ client: c }) => c.name.toLowerCase().includes(q));

  if (o.plan !== "all") list = list.filter(({ client: c }) => c.plan === o.plan);

  if (o.tz && o.tz !== "all") list = list.filter(({ client: c }) => c.time_zone === o.tz);

  /*
   * Billing window: the next billing date must be in the future AND within N
   * days. `du >= 0` is not redundant — `nextBillingDate` can return today, and
   * a client already past their date is not "billing within a week".
   */
  if (o.billingWindow && o.billingWindow !== "all") {
    const days = parseInt(o.billingWindow, 10);
    list = list.filter(({ client: c }) => {
      const next = nextBillingDate(
        c.billing_anchor_date ?? c.start_date,
        c.billing_interval,
        now,
        c.billing_interval_days,
      );
      if (!next) return false;
      const du = daysUntil(next, now);
      return du >= 0 && du <= days;
    });
  }

  /*
   * The date range filters on START DATE — when the client came on, not
   * anything about this week. A client with no start date has no answer, so it
   * drops out rather than being kept on a technicality.
   */
  if (o.dateFrom || o.dateTo) {
    list = list.filter(({ client: c }) => {
      if (!c.start_date) return false;
      if (o.dateFrom && c.start_date < o.dateFrom) return false;
      if (o.dateTo && c.start_date > o.dateTo) return false;
      return true;
    });
  }

  // Sorting is not done here. The tool's sixteen column sorts live in
  // sorting.ts (`sortWeekly`), applied by the screen AFTER filtering.
  return list;
}

/** How many rows a filter-free view would show — the denominator for "showing N". */
export function visibleTotal(rows: WeeklyRow[]): number {
  return rows.filter(({ client: c }) => !c.hidden && !c.client_paused).length;
}

/*
 * The date presets, as day offsets from today.
 *
 * Returned as a range rather than applied, so the same three buttons can drive
 * the filter and label themselves without the component knowing the arithmetic.
 */
export type DatePreset = "last7" | "last30" | "ytd";

export const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "last7", label: "Last 7 Days" },
  { id: "last30", label: "Last 30 Days" },
  { id: "ytd", label: "Year to Date" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function presetRange(p: DatePreset, now: Date = new Date()): { from: string; to: string } {
  const to = iso(now);
  if (p === "ytd") return { from: `${now.getUTCFullYear()}-01-01`, to };
  // Inclusive of today, so "last 7 days" is today plus the six before it.
  const back = p === "last7" ? 6 : 29;
  const from = new Date(now.getTime() - back * 86_400_000);
  return { from: iso(from), to };
}
