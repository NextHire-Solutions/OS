import type { Overview, OverviewMetric } from "@/lib/workspace/overview";

/*
 * The headline card on Home, following the design's markup and class names.
 *
 * Two departures from the mockup, both deliberate:
 *
 *   · the mockup's stacked avatars beside the reply split are decorative. Real
 *     faces would mean real people, and we have no per-reply owner to draw —
 *     so the split shows its counts and nothing invented.
 *
 *   · a metric with no data renders an em dash, never a zero. On a card this
 *     size a fabricated 0 reads as "nothing happened today", which is a
 *     materially different and much worse claim than "we could not measure".
 */

export function OverviewCard({ overview }: { overview: Overview }) {
  if (overview.unavailable) {
    return (
      <section className="ov-card">
        <div className="ov-top">
          <span className="ov-tile">
            <svg viewBox="0 0 24 24">
              <rect x="2" y="4" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 18v3" />
            </svg>
          </span>
          <span className="ov-title">Overview</span>
        </div>
        <div style={{ padding: "8px 22px 24px", fontSize: 13.5, color: "var(--muted)" }}>
          {overview.unavailable}
        </div>
      </section>
    );
  }

  return (
    <section className="ov-card">
      <div className="ov-top">
        <span className="ov-tile">
          <svg viewBox="0 0 24 24">
            <rect x="2" y="4" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 18v3" />
          </svg>
        </span>
        <span className="ov-title">Overview</span>
      </div>

      <div className="ovkpis">
        {overview.metrics.map((metric, index) => (
          <div className={`ovk${index === 1 ? " on" : ""}`} key={metric.key}>
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
          </div>
        ))}
      </div>

      {overview.series.length > 0 ? (
        <div className="chart-row">
          <div className="plot">
            <ReplyChart series={overview.series} />
            <div className="xax">
              {edgeLabels(overview.series).map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </div>

          <div className="breakdown">
            <div className="brow">
              <span className="bicon">
                <svg viewBox="0 0 24 24">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
              <span className="btxt">
                <small>Positive</small>
                <b>{count(overview.split.positive)}</b>
              </span>
            </div>
            <div className="brow">
              <span className="bicon">
                <svg viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5M12 16.5v.01" />
                </svg>
              </span>
              <span className="btxt">
                <small>Needs review</small>
                <b>{count(overview.split.needsReview)}</b>
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/*
 * The reply trend, drawn as an area chart.
 *
 * Server-rendered SVG with no client JavaScript: it is a read-only picture of
 * 30 points, and shipping a charting library to draw one polyline would cost
 * more than the whole page.
 */
function ReplyChart({ series }: { series: { date: string; replies: number }[] }) {
  const W = 620;
  const H = 190;
  const values = series.map((p) => p.replies);
  const max = Math.max(1, ...values);

  const x = (i: number) => (series.length <= 1 ? 0 : (i / (series.length - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - 24) - 8;

  const line = series.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.replies).toFixed(1)}`).join(" ");
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Replies per day, last 30 days">
      <defs>
        <linearGradient id="ovg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0165FE" stopOpacity=".16" />
          <stop offset="100%" stopColor="#0165FE" stopOpacity="0" />
        </linearGradient>
        <pattern id="ovd" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1.2" cy="1.2" r="1.2" fill="#DFE3E9" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={W} height={H} fill="url(#ovd)" rx="8" />
      <path d={area} fill="url(#ovg)" />
      <path
        d={line}
        fill="none"
        stroke="#0165FE"
        strokeWidth="3.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function edgeLabels(series: { date: string }[]): string[] {
  if (series.length === 0) return [];
  const at = (i: number) =>
    new Date(`${series[i].date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const last = series.length - 1;
  return [
    at(0),
    at(Math.floor(last / 3)),
    at(Math.floor((2 * last) / 3)),
    at(last),
  ];
}

function count(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("en-US")} replies`;
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
