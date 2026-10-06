"use client";

import { useMemo, useState } from "react";

import type { HomeClients, Overview, OverviewMetric, OverviewSeriesPoint } from "@/lib/workspace/overview";

/*
 * The headline card on Home, following the design's markup and class names.
 *
 * The four figures are TABS: clicking one charts that figure, day by day, over
 * the last 30 days (6 Oct — they used to look clickable and do nothing, and the
 * chart only ever showed replies). The panel beside the chart is the client
 * base — Active / Paused / Churned / Net — from the master record; the old
 * Positive / Needs review split is gone at the client's request.
 *
 * A metric with no data renders an em dash, never a zero: on a card this size
 * a fabricated 0 reads as "nothing happened", which is a much worse claim than
 * "we could not measure".
 */

type SeriesKey = "sent" | "replies" | "reply-rate" | "median-reply";

const CHART_LABEL: Record<SeriesKey, string> = {
  sent: "Emails sent per day",
  replies: "Replies per day",
  "reply-rate": "Reply rate per day",
  "median-reply": "Our median reply time per day (business hours)",
};

function pointValue(p: OverviewSeriesPoint, key: SeriesKey): number | null {
  if (key === "sent") return p.sent;
  if (key === "replies") return p.replies;
  if (key === "reply-rate") return p.replyRate;
  return p.medianSeconds;
}

function formatFor(key: SeriesKey, v: number | null): string {
  if (v === null) return "—";
  if (key === "reply-rate") return `${(v * 100).toFixed(2)}%`;
  if (key === "median-reply") return duration(v);
  return Math.round(v).toLocaleString("en-US");
}

export function OverviewCard({ overview }: { overview: Overview }) {
  const [selected, setSelected] = useState<SeriesKey>("replies");

  if (overview.unavailable) {
    return (
      <section className="ov-card">
        <CardTop />
        <div style={{ padding: "8px 22px 24px", fontSize: 13.5, color: "var(--muted)" }}>
          {overview.unavailable}
        </div>
        {overview.clients ? <div className="chart-row"><div /><ClientsPanel clients={overview.clients} /></div> : null}
      </section>
    );
  }

  return (
    <section className="ov-card">
      <CardTop />

      <div className="ovkpis" role="tablist" aria-label="Choose what the chart shows">
        {overview.metrics.map((metric) => {
          const on = metric.key === selected;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={on}
              className={`ovk${on ? " on" : ""}`}
              key={metric.key}
              onClick={() => setSelected(metric.key as SeriesKey)}
            >
              <div className="ovk-l">
                <span className="bar" />
                {metric.label}
              </div>
              <div className="ovk-n">{formatValue(metric)}</div>
              <div className="ovk-f">
                {metric.delta !== null ? (
                  <span className={`delta${isGood(metric) ? "" : " dn"}`}>
                    {metric.delta >= 0 ? "+" : "−"}
                    {Math.abs(metric.delta * 100).toFixed(1)}%
                  </span>
                ) : null}
                {metric.hint ?? `In the ${overview.windowLabel}`}
              </div>
            </button>
          );
        })}
      </div>

      <div className="chart-row">
        <div className="plot">
          <div className="ov-chart-h">
            <span>{CHART_LABEL[selected]}</span>
            <small>{overview.seriesLabel}</small>
          </div>
          {overview.series.length > 0 ? (
            <SeriesChart series={overview.series} metric={selected} />
          ) : (
            <div className="ov-chart-empty">No daily figures to chart yet.</div>
          )}
        </div>
        {overview.clients ? <ClientsPanel clients={overview.clients} /> : <div />}
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

/*
 * One series, drawn to scale.
 *
 * The SVG is stretched to the panel's width, so the line uses a non-scaling
 * stroke (it used to smear sideways) and everything round — the hover dot, the
 * labels — is HTML laid over it at real percentages, never inside the
 * stretched drawing. Today's running figure is dashed and faded so the line
 * does not appear to collapse at the right edge.
 */
function SeriesChart({ series, metric }: { series: OverviewSeriesPoint[]; metric: SeriesKey }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000;
  const H = 200;
  const PAD_TOP = 10;

  const values = useMemo(() => series.map((p) => pointValue(p, metric)), [series, metric]);
  const known = values.filter((v): v is number => v !== null);
  const top = niceMax(Math.max(0, ...known));
  const n = series.length;
  const xPct = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const xAt = (i: number) => ((xPct(i) / 100) * W).toFixed(1);
  const yOf = (v: number) => H - (top > 0 ? (v / top) * (H - PAD_TOP) : 0);

  // Solid line through complete days; a dashed tail into today's partial day.
  let lastFull = -1;
  series.forEach((p, i) => { if (!p.partial) lastFull = i; });
  const solidEnd = lastFull < 0 ? n - 1 : lastFull;
  const pathFor = (from: number, to: number) => {
    let d = "";
    for (let i = from; i <= to; i++) {
      const v = values[i];
      if (v === null) continue;
      d += `${d ? "L" : "M"} ${xAt(i)} ${yOf(v).toFixed(1)} `;
    }
    return d.trim();
  };
  const solid = pathFor(0, solidEnd);
  const tail = lastFull >= 0 && lastFull < n - 1 ? pathFor(lastFull, n - 1) : "";
  const firstKnown = values.findIndex((v) => v !== null);
  let lastKnown = -1;
  values.forEach((v, i) => { if (v !== null && i <= solidEnd) lastKnown = i; });
  const area = solid && firstKnown >= 0 && lastKnown >= 0 ? `${solid} L ${xAt(lastKnown)} ${H} L ${xAt(firstKnown)} ${H} Z` : "";

  const ticks = [0, Math.floor((n - 1) / 3), Math.floor((2 * (n - 1)) / 3), n - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
  const hv = hover !== null ? values[hover] : null;

  return (
    <div className="ov-chart">
      <div className="ov-yax" aria-hidden="true">
        <span style={{ top: 0 }}>{formatFor(metric, top)}</span>
        <span style={{ top: "50%" }}>{formatFor(metric, top / 2)}</span>
        <span style={{ top: "100%" }}>{formatFor(metric, 0)}</span>
      </div>
      <div
        className="ov-canvas"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
      >
        <div className="ov-grid" aria-hidden="true"><i /><i /><i /></div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`${CHART_LABEL[metric]}, ${series[0]?.date} to ${series[n - 1]?.date}`}>
          <defs>
            <linearGradient id="ovg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0165FE" stopOpacity=".16" />
              <stop offset="100%" stopColor="#0165FE" stopOpacity="0" />
            </linearGradient>
          </defs>
          {area ? <path d={area} fill="url(#ovg)" /> : null}
          {solid ? <path d={solid} fill="none" stroke="#0165FE" strokeWidth="2.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" /> : null}
          {tail ? <path d={tail} fill="none" stroke="#0165FE" strokeOpacity=".45" strokeWidth="2.2" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {hover !== null ? (
          <>
            <span className="ov-hline" style={{ left: `${xPct(hover)}%` }} />
            {hv !== null ? <span className="ov-dot" style={{ left: `${xPct(hover)}%`, top: `${(yOf(hv) / H) * 100}%` }} /> : null}
            <span className={`ov-tip${xPct(hover) > 70 ? " left" : ""}`} style={{ left: `${xPct(hover)}%` }}>
              <b>{formatFor(metric, hv)}</b>
              {shortDate(series[hover].date)}{series[hover].partial ? " · so far today" : ""}
            </span>
          </>
        ) : null}
      </div>
      <div className="ov-xax" aria-hidden="true">
        {ticks.map((i) => (
          <span key={series[i].date} style={{ left: `${xPct(i)}%` }} className={i === 0 ? "first" : i === n - 1 ? "last" : undefined}>
            {shortDate(series[i].date)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Active / Paused / Churned / Net, from the master record. */
function ClientsPanel({ clients }: { clients: HomeClients }) {
  const rows: Array<{ label: string; value: string; tone: string; sub?: string }> = [
    { label: "Active clients", value: String(clients.active), tone: "var(--green)" },
    { label: "Paused", value: String(clients.paused), tone: "var(--amber)" },
    { label: "Churned", value: String(clients.churned), tone: "var(--red)" },
    {
      label: `Net this month (${clients.monthLabel})`,
      value: `${clients.net > 0 ? "+" : clients.net < 0 ? "−" : ""}${Math.abs(clients.net)}`,
      tone: clients.net >= 0 ? "var(--green)" : "var(--red)",
      sub: `${clients.added} added · ${clients.churnedThisMonth} churned`,
    },
  ];
  return (
    <div className="breakdown ov-clients" aria-label="Clients">
      {rows.map((r) => (
        <div className="brow" key={r.label}>
          <span className="ov-cdot" style={{ background: r.tone }} />
          <span className="btxt">
            <small>{r.label}</small>
            <b>{r.value}</b>
            {r.sub ? <em>{r.sub}</em> : null}
          </span>
        </div>
      ))}
      {clients.onboarding ? <div className="ov-cfoot">{clients.onboarding} onboarding</div> : null}
    </div>
  );
}

/** A round axis top just above the largest value: 0, ½ and the top are labelled. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  if (v < 1) return Math.ceil(v * 1000) / 1000; // rates
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function duration(value: number): string {
  if (value >= 3600) return `${(value / 3600).toFixed(1)}h`;
  if (value >= 60) return `${Math.round(value / 60)}m`;
  return `${Math.round(value)}s`;
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
  if (format === "duration") return duration(value);
  return value.toLocaleString("en-US");
}
