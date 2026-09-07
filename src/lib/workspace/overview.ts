import "server-only";

import { httpProbe } from "@/lib/http/probe";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";

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
  positive: number;
}

export interface Overview {
  metrics: OverviewMetric[];
  series: OverviewSeriesPoint[];
  /** Replies split, for the panel beside the chart. */
  split: { positive: number | null; needsReview: number | null };
  windowLabel: string;
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

export async function getOverview(): Promise<Overview> {
  const empty: Overview = {
    metrics: [],
    series: [],
    split: { positive: null, needsReview: null },
    windowLabel: "last 7 days",
    unavailable: null,
  };

  const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
  if (!secret) return { ...empty, unavailable: "ANALYTICS_AUTH_SECRET not set" };

  const email = optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com";
  const token = await mintAnalyticsSession(secret, email);
  const cookie = { cookie: `bsa_session=${token}` };
  const base = baseUrlEnv("ANALYTICS_URL");

  // Current 7 days, the 7 before it, the series, and our own reply time.
  const [current, previous, series, followUp] = await Promise.allSettled([
    httpProbe(`${base}/api/analytics/kpis?preset=7d`, { timeoutMs: TIMEOUT, headers: cookie }),
    /*
     * The seven days immediately BEFORE the current seven — day 13 back to
     * day 7, adjacent to preset=7d's day 6 to day 0.
     *
     * These were 14→8, which left a one-day hole between the windows: the
     * comparison quietly ignored a day's sending. The delta still looked
     * plausible, which is exactly why it survived a first reading and only
     * surfaced when the figure was recomputed from the daily series.
     */
    httpProbe(
      `${base}/api/analytics/kpis?from=${isoDaysAgo(13)}&to=${isoDaysAgo(7)}`,
      { timeoutMs: TIMEOUT, headers: cookie },
    ),
    httpProbe(`${base}/api/analytics/timeseries?preset=30d`, { timeoutMs: TIMEOUT, headers: cookie }),
    masterInboxMedian(),
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
  const positive = num(now.positive);

  const medianSeconds =
    followUp.status === "fulfilled" ? followUp.value : null;

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

  return {
    metrics,
    series: Array.isArray(points)
      ? points.flatMap((raw) => {
          const row = asRecord(raw);
          const date = typeof row?.date === "string" ? row.date : null;
          if (!date) return [];
          return [{
            date,
            sent: num(row?.sent) ?? 0,
            replies: num(row?.replies) ?? 0,
            positive: num(row?.positive) ?? 0,
          }];
        })
      : [],
    split: {
      positive,
      // Everything that replied and was not marked positive still needs a
      // human decision. Derived, and labelled as such on the card.
      needsReview: replies !== null && positive !== null ? Math.max(0, replies - positive) : null,
    },
    windowLabel: "last 7 days",
    unavailable: null,
  };
}

/** Our own median first-response, business hours, from Master Inbox. */
async function masterInboxMedian(): Promise<number | null> {
  const to = isoDaysAgo(0);
  const from = isoDaysAgo(7);
  const res = await httpProbe(
    `${baseUrlEnv("MASTER_INBOX_URL")}/api/metrics/follow-up-time?from=${from}&to=${to}`,
    { timeoutMs: TIMEOUT },
  );
  if (!res.ok) return null;
  return num(asRecord(asRecord(res.json)?.overall)?.median_seconds);
}
