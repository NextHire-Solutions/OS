import "server-only";

import { analyticsRead } from "@/lib/tools/analytics/in-process";
import { ttlCache } from "@/lib/cache/ttl";
import { getMasterClientList } from "@/lib/clients/master-list";
import { performanceFrom } from "./performance-model";
import { interestedByDay } from "./interested";
import { chartPoints, homeMetrics, sumWindow, type ChartPoint, type KpiWindow, type OverviewMetric } from "./overview-model";

/*
 * The headline band on Home.
 *
 * ---------------------------------------------------------------------------
 * WHERE EACH NUMBER COMES FROM
 *
 *   Emails sent, replies,    Analytics — authoritative for campaign volume.
 *   people emailed           Two KPI windows (this week, the week before) for
 *                            the tiles and their deltas; the daily series for
 *                            the chart.
 *   Interested               MASTER INBOX — the threads labelled Interested
 *                            (interested.ts). Asked for by name on 13 Oct, and
 *                            not the same thing as Analytics' "Positive".
 *
 * The arithmetic — both reply rates, the Interested rate, the deltas — is in
 * overview-model.ts, where it is tested.
 *
 * "Median reply" (how long WE take to answer, from Master Inbox) was the
 * fourth tile until 13 Oct and was removed at the client's request, with the
 * Active / Paused / Churned / Net panel. The client counts are still returned
 * for the Assistant; Home does not draw them.
 *
 * ---------------------------------------------------------------------------
 * DELTAS
 *
 * The KPI payload carries no deltas, so the change badges are computed here by
 * asking for the preceding window of the same length.
 */

export type { OverviewMetric, ChartPoint } from "./overview-model";

/** The client base, from the master record. No longer on Home (13 Oct); the Assistant still reads it. */
export interface HomeClients {
  active: number;
  paused: number;
  churned: number;
  onboarding: number;
  /** This calendar month: added − churned (the Performance page's definition). */
  net: number;
  added: number;
  churnedThisMonth: number;
  monthLabel: string;
}

export interface Overview {
  metrics: OverviewMetric[];
  /** The last 30 days, in the campaign tool's chart shape; `positive` carries Master Inbox's Interested. */
  series: ChartPoint[];
  /** The tiles cover `windowLabel`; the chart covers `seriesLabel`. */
  windowLabel: string;
  seriesLabel: string;
  /** False when Master Inbox could not be read: the two Interested tiles show a dash, the chart has no Interested line. */
  interestedLive: boolean;
  clients: HomeClients | null;
  unavailable: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** ISO date, N days back from today, in UTC. */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function loadOverview(): Promise<Overview> {
  const empty: Overview = {
    metrics: [],
    series: [],
    windowLabel: "last 7 days",
    seriesLabel: "last 30 days",
    interestedLive: false,
    clients: null,
    unavailable: null,
  };

  // Current 7 days, the 7 before it, the 30-day series, and Master Inbox's Interested.
  const [current, previous, series, interested] = await Promise.allSettled([
    // In-process — the standalone Analytics app is being switched off.
    analyticsRead("/api/analytics/kpis?preset=7d"),
    /*
     * The seven days immediately BEFORE the current seven — day 13 back to
     * day 7, adjacent to preset=7d's day 6 to day 0.
     *
     * These were 14→8, which left a one-day hole between the windows: the
     * comparison quietly ignored a day's sending. The delta still looked
     * plausible, which is exactly why it survived a first reading and only
     * surfaced when the figure was recomputed from the daily series.
     */
    analyticsRead(`/api/analytics/kpis?from=${isoDaysAgo(13)}&to=${isoDaysAgo(7)}`),
    analyticsRead("/api/analytics/timeseries?preset=30d"),
    interestedByDay(31),
  ]);

  const now =
    current.status === "fulfilled" && current.value.ok
      ? asRecord(asRecord(current.value.json)?.current)
      : null;
  if (!now) {
    return { ...empty, unavailable: "Analytics KPIs are unavailable" };
  }

  const before =
    previous.status === "fulfilled" && previous.value.ok
      ? asRecord(asRecord(previous.value.json)?.current)
      : null;

  const window = (r: Record<string, unknown>): KpiWindow => ({
    sent: num(r.sent),
    replies: num(r.replies),
    prospects: num(r.prospects),
  });

  /*
   * Master Inbox unreadable is not "nobody was interested": the two Interested
   * tiles then carry a dash, and the chart says the line is missing.
   */
  const interestedLive = interested.status === "fulfilled";
  const byDay = interestedLive ? interested.value : new Map<string, number>();
  if (!interestedLive) console.error("[home] Interested could not be read from Master Inbox", interested.reason);
  // The same two windows the KPI calls cover.
  const interestedNow = interestedLive ? sumWindow(byDay, isoDaysAgo(6), isoDaysAgo(0)) : null;
  const interestedBefore = interestedLive ? sumWindow(byDay, isoDaysAgo(13), isoDaysAgo(7)) : null;

  const points =
    series.status === "fulfilled" && series.value.ok
      ? asRecord(series.value.json)?.points
      : null;

  return {
    ...empty,
    interestedLive,
    metrics: homeMetrics(window(now), before ? window(before) : null, interestedNow, interestedBefore),
    series: chartPoints(points, byDay),
  };
}

/**
 * Active / Paused / Churned / Net, from the master record (client ask, 6 Oct).
 * Net is this calendar month's added − churned — the Performance page's own
 * definition, computed by the same function, so the two screens agree.
 */
export async function homeClients(): Promise<HomeClients | null> {
  try {
    const { clients } = await getMasterClientList();
    const p = performanceFrom(clients, null, null);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const m = p.months.find((x) => x.month === thisMonth);
    return {
      active: p.totals.active ?? 0,
      paused: p.totals.paused ?? 0,
      churned: p.totals.churned ?? 0,
      onboarding: p.totals.onboarding ?? 0,
      net: m?.net ?? 0,
      added: m?.added ?? 0,
      churnedThisMonth: m?.churned ?? 0,
      monthLabel: new Date().toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }),
    };
  } catch {
    return null;
  }
}

/*
 * Home's numbers, from a short cache.
 *
 * Four reads — two KPI windows, the 30-day series and Master Inbox's
 * Interested (our own reply time was the fourth until 13 Oct) — took
 * ~1.2s on every visit to Home, with nothing cached. They describe the last
 * seven days, so a minute-old answer is the same answer: fresh for a minute,
 * then served stale for up to ten while it refreshes behind. An answer that
 * says Analytics was unavailable is not kept, so the next visit tries again.
 * instrumentation.ts keeps it warm.
 */
// `-v2`: the shape changed on 13 Oct. A shared cache outlives a hot reload, and
// the old four-tile answer must not be handed to the new card.
const overviewCache = ttlCache(loadOverview, { ttlMs: 60_000, staleMs: 10 * 60_000, shared: "home-overview-v2" });

export async function getOverview(): Promise<Overview> {
  // The client counts are read apart from the 60s cache, so a status change
  // shows on Home as soon as the master record has it.
  const [result, clients] = await Promise.all([overviewCache(), homeClients()]);
  if (result.unavailable) overviewCache.invalidate();
  return { ...result, clients };
}
