import { lastBillingDate, nextBillingDate, todayInET } from "./derive.ts";
import type { WeeklyRow } from "./summarize.ts";

/*
 * The Weekly view's column sorts — a port of the tool's own branches.
 *
 * Kept out of the component so they are testable without a browser, and so
 * every "sinks to the bottom" rule is stated once. That rule is the whole
 * subtlety here, and it is not decoration:
 *
 *   a client with NO time zone is not "the earliest time zone";
 *   a client with NO monthly target is not "furthest behind";
 *   a client with NO introductions is not "the longest since the last one";
 *   a client with NO funnel is not "the worst conversion rate".
 *
 * Each of those would put exactly the clients nobody has set up yet at the top
 * of the list somebody scans to decide who needs attention. So missing values
 * sink in BOTH directions, and ties fall back to name order — without that,
 * equal rows shuffle between renders for no reason.
 */

export type SortCol =
  | "tz" | "monthly" | "lastIntro" | "lastBilling" | "billing" | "billingDays"
  | "today" | "emails"
  | "intros" | "conv" | "leftWeek" | "progress" | "interested"
  | "converted" | "convRate" | "campaigns";

export interface Sort {
  col: SortCol;
  dir: "asc" | "desc";
}

const byName = (a: WeeklyRow, b: WeeklyRow) => a.client.name.localeCompare(b.client.name);

/**
 * Sums one weekly metric across every week the client has loaded.
 *
 * Reads the field by name rather than by property access so one helper covers
 * both columns; `WeeklyMetric` has no index signature, hence the cast.
 */
function sumWeeks(row: WeeklyRow, field: "interested_corofy" | "intros_corofy"): number {
  return Object.values(row.client.metricsByWeek).reduce(
    (total, m) => total + ((m as unknown as Record<string, number | null>)[field] ?? 0),
    0,
  );
}

/**
 * Converted as a share of the whole funnel, or null when there is no funnel.
 *
 * Null rather than zero, because "nobody has replied yet" and "everybody
 * replied and none converted" are opposite situations.
 */
function convRateFor(row: WeeklyRow): number | null {
  const converted = sumWeeks(row, "intros_corofy");
  const interested = sumWeeks(row, "interested_corofy");
  const funnel = converted + interested;
  return funnel > 0 ? (converted / funnel) * 100 : null;
}

/** Today's emails count only when the stored date IS today, in Eastern. */
function todayEmails(row: WeeklyRow, today: string): number {
  const c = row.client as unknown as { emails_today_date?: string | null; emails_today?: number | null };
  return c.emails_today_date === today ? (c.emails_today ?? 0) : 0;
}

function campaignScore(row: WeeklyRow): { active: number; total: number } {
  const all = [...row.client.campaigns, ...row.client.bisonCampaigns];
  return { active: all.filter((x) => x.status === "running").length, total: all.length };
}

/**
 * Applies one column sort.
 *
 * `now` is passed in rather than read from the clock: the billing sort depends
 * on today's date, and reading it during render is the hydration bug that has
 * already shipped three times in this workspace.
 */
export function sortWeekly(rows: WeeklyRow[], sort: Sort | null, now: Date): WeeklyRow[] {
  if (!sort) return rows;
  const mul = sort.dir === "desc" ? 1 : -1;

  /** Numeric sorts: plain, with a name tiebreak. */
  const num = (score: (r: WeeklyRow) => number) =>
    [...rows].sort((a, b) => mul * (score(b) - score(a)) || byName(a, b));

  /** Sorts where a missing value must sink whichever way the arrow points. */
  const sinking = (score: (r: WeeklyRow) => number | null) =>
    [...rows].sort((a, b) => {
      const x = score(a);
      const y = score(b);
      if (x === null && y === null) return byName(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      return mul * (y - x) || byName(a, b);
    });

  const today = todayInET(now);

  switch (sort.col) {
    case "leftWeek": return num((r) => r.derived.leftThisWeek);
    case "emails": return num((r) => r.derived.emails);
    case "intros": return num((r) => r.derived.intros);
    case "progress": return num((r) => r.derived.campaignsAvgPct);
    case "interested": return num((r) => sumWeeks(r, "interested_corofy"));
    case "converted": return num((r) => sumWeeks(r, "intros_corofy"));
    case "today": return num((r) => todayEmails(r, today));

    case "conv": return sinking((r) => r.derived.convPct);
    case "convRate": return sinking(convRateFor);

    // A client with no monthly target has no monthly progress to compare.
    case "monthly":
      return sinking((r) =>
        r.client.monthly_target === 0 ? null : r.client.intros_this_month,
      );

    /*
     * Most recent first when descending; never-introduced sinks either way.
     *
     * Negated because `daysSince` counts the wrong way round — a smaller
     * number is a more recent introduction, and descending should put the
     * most recent at the top, matching the tool's timestamp sort.
     */
    case "lastIntro":
      return sinking((r) => (r.derived.daysSince === null ? null : -r.derived.daysSince));

    /*
     * The LAST billing day, which is null until a client has billed once —
     * a new client has not "billed longest ago", it has not billed at all.
     */
    case "lastBilling":
      return sinking((r) => {
        const d = lastBillingDate(
          r.client.billing_anchor_date ?? r.client.start_date,
          r.client.billing_interval,
          now,
          r.client.billing_interval_days,
        );
        return d ? d.getTime() : null;
      });

    // Days until billing sorts the same set as the date, so it shares its
    // score — otherwise the two columns could disagree about the same rows.
    case "billingDays":
    case "billing":
      return sinking((r) => {
        const d = nextBillingDate(
          r.client.billing_anchor_date ?? r.client.start_date,
          r.client.billing_interval,
          now,
          r.client.billing_interval_days,
        );
        return d ? d.getTime() : null;
      });

    // Text, so it cannot go through the numeric paths. Empty still sinks.
    case "tz":
      return [...rows].sort((a, b) => {
        const x = a.client.time_zone ?? "";
        const y = b.client.time_zone ?? "";
        if (!x && !y) return byName(a, b);
        if (!x) return 1;
        if (!y) return -1;
        return -mul * x.localeCompare(y) || byName(a, b);
      });

    // Running campaigns first, then how many there are in total.
    case "campaigns":
      return [...rows].sort((a, b) => {
        const x = campaignScore(a);
        const y = campaignScore(b);
        return mul * (y.active - x.active) || mul * (y.total - x.total) || byName(a, b);
      });

    default:
      return rows;
  }
}
