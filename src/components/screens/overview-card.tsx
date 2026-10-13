"use client";

import { useState } from "react";

import type { Overview, OverviewMetric } from "@/lib/workspace/overview";
import type { SeriesKey } from "@/lib/tools/analytics/series.ts";

import { SeriesChart, SeriesChips, type SeriesLabels } from "./analytics/chart";
import { Check, Seg } from "./analytics/shared";

/*
 * The headline card on Home.
 *
 * 13 Oct, from the client's notes on Home — all four changes are here:
 *
 *   · "Remove Median Reply"                      gone, with its daily series
 *   · "Add … Interested Reply, Interested Reply  six tiles now: both reply
 *      Rate, Reply Rate per Contact … need both"  rates and both Interested
 *                                                figures (overview-model.ts)
 *   · "The graph really needs to improve (use    the graph IS the campaign
 *      same graph UI as campaign tool)"          tool's — the same component,
 *                                                chips, Volume / Rates and
 *                                                drag-to-read
 *   · "Remove Active, paused, churned, net"      the panel beside the chart
 *                                                is gone; the chart takes the
 *                                                full width
 *
 * The tiles used to be tabs that chose what the old chart drew. The campaign
 * tool's chart chooses its own lines, with chips, so the tiles are plain
 * figures again — two ways to choose one thing was one too many.
 *
 * A metric with no data renders an em dash, never a zero: on a card this size
 * a fabricated 0 reads as "nothing happened", which is a much worse claim than
 * "we could not measure".
 */

/*
 * The chart's lines, in the campaign tool's own keys. On Home the `positive`
 * line is Master Inbox's Interested (not Analytics' Positive), and is named
 * for what it is; Human replies is left to the campaign tool, where its
 * definition is explained.
 */
const LINES: readonly SeriesKey[] = ["sent", "prospects", "replies", "positive", "bounces"];
const LABELS: SeriesLabels = { positive: "Interested", prospects: "People emailed" };
const NOUN: Record<SeriesKey, string> = {
  sent: "Emails sent",
  prospects: "People emailed",
  replies: "Replies",
  human: "Human replies",
  positive: "Interested replies",
  bounces: "Bounces",
};
const RATE_NOUN: Partial<Record<SeriesKey, string>> = {
  replies: "Reply rate per email",
  positive: "Interested reply rate",
  bounces: "Bounce rate",
};

function chartTitle(series: SeriesKey[], mode: "volume" | "rates"): string {
  if (series.length !== 1) return mode === "rates" ? "Rates per day" : "Volume per day";
  return mode === "rates" ? `${RATE_NOUN[series[0]] ?? NOUN[series[0]]} per day` : `${NOUN[series[0]]} per day`;
}

export function OverviewCard({ overview }: { overview: Overview }) {
  const [mode, setMode] = useState<"volume" | "rates">("volume");
  const [series, setSeries] = useState<SeriesKey[]>(["replies", "positive"]);
  const [normalize, setNormalize] = useState(false);

  if (overview.unavailable) {
    return (
      <section className="ov-card">
        <CardTop />
        <div style={{ padding: "8px 22px 24px", fontSize: 13.5, color: "var(--muted)" }}>
          {overview.unavailable}
        </div>
      </section>
    );
  }

  // Without Master Inbox there is no Interested line to draw — offering the
  // chip would draw a flat zero and call it a fact.
  const lines = overview.interestedLive ? LINES : LINES.filter((k) => k !== "positive");
  const shown = series.filter((k) => lines.includes(k));
  const selected = shown.length ? shown : (["replies"] as SeriesKey[]);

  return (
    <section className="ov-card" data-home-overview>
      <CardTop />

      <div className="ovkpis ovkpis-6" data-home-tiles>
        {overview.metrics.map((metric) => (
          <div className="ovk ovk-plain" key={metric.key} data-home-tile={metric.key}>
            <div className="ovk-l">{metric.label}</div>
            <div className="ovk-n">{formatValue(metric)}</div>
            <div className="ovk-f">
              {metric.delta !== null ? (
                <span className={`delta${isGood(metric) ? "" : " dn"}`}>
                  {metric.delta >= 0 ? "+" : "−"}
                  {Math.abs(metric.delta * 100).toFixed(1)}%
                </span>
              ) : null}
              <span className="ovk-hint">{metric.hint ?? `In the ${overview.windowLabel}`}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="ov-window">
        Tiles: the {overview.windowLabel}, against the 7 days before. Chart: the {overview.seriesLabel}.
        {overview.interestedLive ? null : " Interested could not be read from Master Inbox just now."}
      </p>

      {/* The campaign tool's chart card, as it is drawn there (analytics/campaign.tsx). */}
      <div className="lc-card ov-chart-card" data-home-chart>
        <div className="lc-head" style={{ alignItems: "center", padding: "10px 22px 4px" }}>
          <h2 className="lc-title" title="Drag across the chart to read any day">{chartTitle(selected, mode)}</h2>
          <SeriesChips selected={selected} mode={mode} onChange={setSeries} labels={LABELS} only={lines} />
          <div className="an-lc-tools" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <Seg
              label="Chart mode"
              value={mode}
              options={[
                { value: "volume", label: "Volume" },
                { value: "rates", label: "Rates" },
              ]}
              onChange={(m) => {
                setMode(m);
                // Sent and People emailed have no rate — they are what the
                // others are divided by. Left selected they would vanish.
                if (m === "rates") {
                  const kept = selected.filter((k) => k !== "sent" && k !== "prospects");
                  setSeries(kept.length ? kept : ["replies"]);
                }
              }}
            />
            <Check checked={normalize} onChange={setNormalize} label="Normalize" tip="Each line to its own scale" />
          </div>
        </div>
        {overview.series.length > 0 ? (
          <SeriesChart data={{ points: overview.series, mode }} series={selected} mode={mode} normalize={normalize} labels={LABELS} />
        ) : (
          <div className="ov-chart-empty">No daily figures to chart yet.</div>
        )}
      </div>
    </section>
  );
}

function CardTop() {
  return (
    <div className="ov-top">
      <span className="ov-tile">
        <svg viewBox="0 0 24 24">
          <rect x="2" y="4" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 18v3" />
        </svg>
      </span>
      <span className="ov-title">Overview</span>
    </div>
  );
}

/** A drop in reply time is good; a drop in sent is not. */
function isGood(metric: OverviewMetric): boolean {
  if (metric.delta === null) return true;
  return metric.higherIsBetter ? metric.delta >= 0 : metric.delta < 0;
}

function formatValue(metric: OverviewMetric): string {
  const { value, format } = metric;
  if (value === null) return "—";
  if (format === "percent") return `${(value * 100).toFixed(2)}%`;
  if (format === "duration") {
    if (value >= 3600) return `${(value / 3600).toFixed(1)}h`;
    if (value >= 60) return `${Math.round(value / 60)}m`;
    return `${Math.round(value)}s`;
  }
  return value.toLocaleString("en-US");
}
