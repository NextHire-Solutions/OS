"use client";

import { useEffect } from "react";

import { SYNC_STATUS_URL, useAnalyticsData } from "./actions";

/*
 * The staleness strip — the tool's `layout/staleness-strip.tsx`.
 *
 * Every number on these screens is a cached copy of EmailBison and Instantly.
 * When a sync stops, nothing breaks visibly — the charts still draw, the KPIs
 * still read plausible, and they are simply wrong by however long the outage
 * has run. This strip is the only thing standing between that and a decision
 * made on last week's data.
 *
 * It renders NOTHING when healthy, and nothing while loading. A banner that is
 * usually present is a banner nobody sees. A failed health check is likewise
 * silent: it is not itself evidence of stale data.
 *
 * Polled every five minutes, the tool's own interval, through the same
 * `/sync/status` route the cron dispatcher reads — so the strip and the cron
 * can never disagree about what "stale" means.
 */

interface SyncStatus {
  healthy: boolean;
  degraded: string[];
  jobs: Array<{ job: string; status: string; lastSuccessAt: string | null }>;
}

const POLL_MS = 5 * 60_000;

function agoLabel(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

export function StalenessStrip() {
  const { data, reload } = useAnalyticsData<SyncStatus>(SYNC_STATUS_URL);

  useEffect(() => {
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  // `Date.now()` is safe here: the server and the first client render both see
  // `data === null` and draw nothing, so there is no hydration to mismatch.
  if (!data || data.healthy) return null;

  const worst = data.jobs
    .filter((j) => data.degraded.includes(j.job))
    .sort((a, b) => (a.lastSuccessAt ?? "").localeCompare(b.lastSuccessAt ?? ""))[0];

  return (
    <div className="an-stale" role="status">
      <span aria-hidden>⚠</span>
      <span>
        <b>Data may be stale</b> — {worst?.job ?? "a sync"} last succeeded{" "}
        {agoLabel(worst?.lastSuccessAt ?? null)}
      </span>
      {data.degraded.length > 1 ? (
        <span className="mut">({data.degraded.length} jobs affected)</span>
      ) : null}
    </div>
  );
}
