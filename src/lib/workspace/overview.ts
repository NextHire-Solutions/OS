import "server-only";

import { analyticsRead } from "@/lib/tools/analytics/in-process";
import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv } from "@/lib/env";
import { ttlCache } from "@/lib/cache/ttl";
import { getMasterClientList } from "@/lib/clients/master-list";
import { performanceFrom } from "./performance-model";

/*
 * The headline band on Home.
 *
 * ---------------------------------------------------------------------------
 * WHERE EACH NUMBER COMES FROM, AND WHY IT IS NOT ALL ONE SOURCE
 *
 * Sent, replies and reply rate come from Analytics, which is authoritative for
 * campaign volume. Median reply comes from MASTER INBOX, deliberately — the two
 * apps both have something called a reply time and they measure opposite ends
 * of the conversation:
 *
 *   Analytics `medianReplyTime`      how long a PROSPECT took to answer us
 *   Master Inbox follow-up-time      how long WE took to answer a prospect,
 *                                    counted in business hours only
 *
 * The design's "Median reply" sits beside team-performance figures and is the
 * second. Using Analytics' number because it shares a name would put 33 hours
 * on the card and quietly mean something else entirely.
 *
 * ---------------------------------------------------------------------------
 * DELTAS
 *
 * The KPI payload carries no deltas, so the change badges are computed here by
 * asking for the preceding window of the same length. Two requests instead of
 * one, on a page that caches for 30 seconds. The alternative was dropping the
 * badges the design leads with, or inventing them.
 */

const TIMEOUT = 12_000;

export interface OverviewMetric {
  key: string;
  label: string;
  value: number | null;
  format: "compact" | "percent" | "duration";
  /** Fractional change on the previous window. null when not computable. */
  delta: number | null;
  /** Higher is better? Drives the badge colour, not its sign. */
  higherIsBetter: boolean;
  hint?: string;
}

export interface OverviewSeriesPoint {
  date: string;
  sent: number;
  replies: number;
  /** replies ÷ sent that day; null on a day nothing was sent. */
  replyRate: number | null;
  /** Our median first response that day, business hours; null when unknown. */
  medianSeconds: number | null;
  /** Today, still running — drawn apart so the line does not "dive" at the end. */
  partial: boolean;
}

/** The client base, from the master record — the panel beside the chart. */
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
  series: OverviewSeriesPoint[];
  /** The tiles cover `windowLabel`; the chart covers `seriesLabel`. */
  windowLabel: string;
  seriesLabel: string;
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

function change(current: number | null, previous: number | null): number | null {
  // A jump from zero is infinite, not a percentage. Reporting it as one would
  // put "+Infinity%" or a nonsense figure on the card.
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

async function loadOverview(): Promise<Overview> {
  const empty: Overview = {
    metrics: [],
    series: [],
    windowLabel: "last 7 days",
    seriesLabel: "last 30 days",
    clients: null,
    unavailable: null,
  };


  // Current 7 days, the 7 before it, the series, and our own reply time.
  const [current, previous, series, followUp] = await Promise.allSettled([
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
    masterInboxReplyTimes(),
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

  const replies = num(now.replies);

  const medianSeconds =
    followUp.status === "fulfilled" ? followUp.value.overall : null;
  const medianByDay = followUp.status === "fulfilled" ? followUp.value.byDay : new Map<string, number>();

  const metrics: OverviewMetric[] = [
    {
      key: "sent",
      label: "Emails sent",
      value: num(now.sent),
      format: "compact",
      delta: change(num(now.sent), num(before?.sent)),
      higherIsBetter: true,
    },
    {
      key: "replies",
      label: "Replies received",
      value: replies,
      format: "compact",
      delta: change(replies, num(before?.replies)),
      higherIsBetter: true,
    },
    {
      key: "reply-rate",
      label: "Reply rate",
      value: num(now.replyRate),
      format: "percent",
      delta: change(num(now.replyRate), num(before?.replyRate)),
      higherIsBetter: true,
    },
    {
      key: "median-reply",
      label: "Median reply",
      value: medianSeconds,
      format: "duration",
      // Master Inbox publishes one window at a time, so there is nothing to
      // compare against. No badge rather than a fabricated one.
      delta: null,
      higherIsBetter: false,
      hint: "How long we take to answer, business hours only",
    },
  ];

  const points =
    series.status === "fulfilled" && series.value.ok
      ? asRecord(series.value.json)?.points
      : null;
  // "Today" in the business's day (Eastern), which is how the series is bucketed.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  return {
    ...empty,
    metrics,
    series: Array.isArray(points)
      ? points.flatMap((raw) => {
          const row = asRecord(raw);
          const date = typeof row?.date === "string" ? row.date : null;
          if (!date) return [];
          const sent = num(row?.sent) ?? 0;
          const replyCount = num(row?.replies) ?? 0;
          return [{
            date,
            sent,
            replies: replyCount,
            replyRate: sent > 0 ? replyCount / sent : null,
            medianSeconds: medianByDay.get(date) ?? null,
            partial: date >= today,
          }];
        })
      : [],
  };
}

/**
 * Our own median first-response, business hours, from Master Inbox: the exact
 * median over the last 7 days for the tile, and each day's median over the
 * last 30 for the chart (a median cannot be rebuilt from daily ones, hence two).
 */
async function masterInboxReplyTimes(): Promise<{ overall: number | null; byDay: Map<string, number> }> {
  const base = `${baseUrlEnv("MASTER_INBOX_URL")}/api/metrics/follow-up-time`;
  const [week, month] = await Promise.all([
    httpProbe(`${base}?from=${isoDaysAgo(7)}&to=${isoDaysAgo(0)}`, { timeoutMs: TIMEOUT }),
    httpProbe(`${base}?from=${isoDaysAgo(30)}&to=${isoDaysAgo(0)}`, { timeoutMs: TIMEOUT }),
  ]);
  const byDay = new Map<string, number>();
  const days = month.ok ? asRecord(month.json)?.days : null;
  if (Array.isArray(days)) {
    for (const d of days) {
      const r = asRecord(d);
      const n = num(r?.median_seconds);
      if (typeof r?.date === "string" && n !== null && (num(r?.sample_size) ?? 0) > 0) byDay.set(r.date, n);
    }
  }
  return { overall: week.ok ? num(asRecord(asRecord(week.json)?.overall)?.median_seconds) : null, byDay };
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
 * Four reads — two KPI windows, the 30-day series and our reply time — took
 * ~1.2s on every visit to Home, with nothing cached. They describe the last
 * seven days, so a minute-old answer is the same answer: fresh for a minute,
 * then served stale for up to ten while it refreshes behind. An answer that
 * says Analytics was unavailable is not kept, so the next visit tries again.
 * instrumentation.ts keeps it warm.
 */
const overviewCache = ttlCache(loadOverview, { ttlMs: 60_000, staleMs: 10 * 60_000, shared: "home-overview" });

export async function getOverview(): Promise<Overview> {
  // The client counts are read apart from the 60s cache, so a status change
  // shows on Home as soon as the master record has it.
  const [result, clients] = await Promise.all([overviewCache(), homeClients()]);
  if (result.unavailable) overviewCache.invalidate();
  return { ...result, clients };
}
