"use client";

import { useMemo, useRef, useState } from "react";

import { SERIES, type SeriesKey } from "@/lib/tools/analytics/series.ts";
import { compactNumber, fullNumber, percent } from "@/lib/tools/analytics/format.ts";
import { dayStamp } from "@/lib/workspace/dates";
import { SERIES_COLOR } from "./palette";

/*
 * The time series, drawn as SVG.
 *
 * The tool draws this with Recharts. The workspace has no charting library and
 * this port does not add one — partly because a 500KB dependency for six
 * polylines is a poor trade, but mostly because workspace.css already carries a
 * complete, unused line-chart vocabulary written for exactly this screen:
 * `.lc-card`, `.lchart`, `.lc-grid`, `.lc-ax`, `.lc-line`, `.lc-dot`,
 * `.lc-cross`, `.lc-active` and the `.lc-tip` bubble with its rows and tail.
 * Its comment says "interactive, drag-to-read … snaps to whole data points",
 * which is the interaction below.
 *
 * What is preserved from the tool, because these are decisions rather than
 * styling:
 *
 *   · the comparison period is drawn UNDER the current one, dashed and faint,
 *     and paired BY INDEX after the route has tail-aligned the two arrays;
 *   · a null point is a GAP, never a zero — `M`/`L` restarts on a null;
 *   · Rates mode divides by the right denominator per series, and Positive's
 *     denominator is Replies, not Sent (`toRate`, quoted from charts-view.tsx);
 *   · colour follows the entity, from `series.ts`, never the selection order.
 */

export interface Point {
  date: string;
  sent: number;
  prospects: number;
  replies: number;
  human: number;
  positive: number;
  bounces: number;
}

export interface Series {
  points: Point[];
  compare?: Array<Point | null>;
  compareLabel?: { from: string; to: string };
  mode?: "volume" | "rates";
}

/**
 * One point's value for one series, in the current mode.
 *
 * Quoted from the tool's `charts-view.tsx`. The Positive exception is the whole
 * reason this is a function and not a lookup: Positive Rate is
 * `positive / replies` everywhere else in the product, and dividing it by Sent
 * here would put a different number on the chart from the one in the band.
 */
function value(point: Point | null, key: SeriesKey, mode: "volume" | "rates"): number | null {
  if (!point) return null;
  if (mode === "volume") return point[key === "human" ? "human" : key] ?? null;
  if (key === "positive") return point.replies > 0 ? point.positive / point.replies : null;
  const denominator = point.sent;
  if (!denominator) return null;
  return (point[key] ?? 0) / denominator;
}

/*
 * The axis ceiling, chosen so the four gridlines land on readable numbers.
 *
 * The axis draws at 0, ¼, ½, ¾ and the top. Taking those fractions of the RAW
 * maximum gave labels like 29.25 · 58.5 · 87.75 · 117 — arithmetically correct
 * and unreadable. The design draws 60 · 90 · 120 · 150, because an axis is a
 * ruler and a ruler has round marks.
 *
 * It rounds the STEP rather than the ceiling, which matters: rounding the
 * ceiling to a power-of-ten-ish number sent a max of 117 all the way to 200 and
 * left the chart using barely half its height. Rounding the step takes 117 to a
 * step of 30 and a ceiling of 120 — round labels AND a line that still fills
 * the plot.
 *
 * Steps come from the set a person reads without effort (1, 2, 2.5, 3, 4, 5,
 * 7.5) times a power of ten. Rates are fractions rather than counts and the
 * same rule holds: a 0.7 maximum gives a 0.2 step, so the axis reads 20% · 40%
 * · 60% · 80%.
 */
function niceCeiling(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const rawStep = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const scaled = rawStep / magnitude;
  const step =
    (scaled <= 1 ? 1
      : scaled <= 2 ? 2
      : scaled <= 2.5 ? 2.5
      : scaled <= 3 ? 3
      : scaled <= 4 ? 4
      : scaled <= 5 ? 5
      : scaled <= 7.5 ? 7.5
      : 10) * magnitude;
  // Floating point: 0.1 * 3 is 0.30000000000000004, which would print as an
  // axis label. Four significant figures is far finer than any label shown.
  return Number((step * 4).toPrecision(12));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const PAD = { top: 14, right: 16, bottom: 26, left: 52 };
const VIEW_W = 1000;
const VIEW_H = 300;

export function SeriesChart({
  data,
  series,
  mode,
  normalize,
}: {
  data: Series;
  series: SeriesKey[];
  mode: "volume" | "rates";
  /** Each line scaled to its own maximum, so a small one is still readable. */
  normalize: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  const points = data.points ?? [];
  const compare = data.compare ?? [];

  const { scales, max } = useMemo(() => {
    const perSeries = new Map<SeriesKey, number>();
    let overall = 0;
    for (const key of series) {
      let m = 0;
      for (const p of points) {
        const v = value(p, key, mode);
        if (v != null && v > m) m = v;
      }
      for (const p of compare) {
        const v = value(p, key, mode);
        if (v != null && v > m) m = v;
      }
      perSeries.set(key, m);
      if (m > overall) overall = m;
    }
    return { scales: perSeries, max: overall };
  }, [points, compare, series, mode]);

  if (points.length === 0) {
    return (
      <div
        style={{
          margin: "0 0 4px", padding: "44px 16px", textAlign: "center",
          border: "1px dashed var(--line)", borderRadius: "var(--r-md)",
          color: "var(--muted)", fontSize: 13.5,
        }}
      >
        No data in this period.
      </div>
    );
  }

  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;

  const ceilingFor = (key: SeriesKey) => {
    const m = normalize ? (scales.get(key) ?? 0) : max;
    return m > 0 ? niceCeiling(m) : 1;
  };

  const x = (i: number) => PAD.left + i * step;
  const y = (v: number, key: SeriesKey) => PAD.top + plotH - (v / ceilingFor(key)) * plotH;

  /** A path that RESTARTS on a null, so a gap is a gap and not a straight line. */
  const path = (rows: Array<Point | null>, key: SeriesKey) => {
    let d = "";
    let pen = false;
    rows.forEach((p, i) => {
      const v = value(p, key, mode);
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v, key).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  /** The same path, closed down to the baseline — the design's `.lc-area`. */
  const area = (rows: Array<Point | null>, key: SeriesKey) => {
    const base = PAD.top + plotH;
    let d = "";
    let runStart: number | null = null;
    let last = 0;
    rows.forEach((p, i) => {
      const v = value(p, key, mode);
      if (v == null) {
        if (runStart != null) d += `L${x(last).toFixed(1)} ${base} L${x(runStart).toFixed(1)} ${base} Z `;
        runStart = null;
        return;
      }
      if (runStart == null) { runStart = i; d += `M${x(i).toFixed(1)} ${y(v, key).toFixed(1)} `; }
      else d += `L${x(i).toFixed(1)} ${y(v, key).toFixed(1)} `;
      last = i;
    });
    if (runStart != null) d += `L${x(last).toFixed(1)} ${base} L${x(runStart).toFixed(1)} ${base} Z`;
    return d.trim();
  };

  /** Roughly six date labels, whatever the range length. */
  const dateEvery = Math.max(1, Math.round(points.length / 6));

  // Four gridlines plus the axis. Labels use the FIRST selected series' scale
  // when normalising, because a shared axis is meaningless once each line has
  // its own ceiling — and the tooltip carries the exact figures regardless.
  const axisKey = series[0] ?? "replies";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    f,
    v: f * ceilingFor(axisKey),
  }));

  const label = (v: number) => (mode === "rates" ? percent(v, 1) : compactNumber(v));

  const onMove = (clientX: number) => {
    const el = box.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = ((clientX - rect.left) / rect.width) * VIEW_W;
    const i = Math.round((rel - PAD.left) / (step || 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  const active = hover != null ? points[hover] : null;

  /** The highest drawn point at the hovered day — the bubble sits above it. */
  const tipY = active
    ? series.reduce((top, key) => {
        const v = value(active, key, mode);
        return v == null ? top : Math.min(top, y(v, key));
      }, PAD.top + plotH)
    : PAD.top;

  return (
    <div
      className={`lchart${hover != null ? " live" : ""}`}
      ref={box}
      tabIndex={0}
      role="img"
      aria-label={`${series.map((s) => SERIES[s].label).join(", ")} over ${points.length} days`}
      onMouseMove={(e) => onMove(e.clientX)}
      onMouseLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1)); }
        if (e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => Math.max(0, (h ?? points.length) - 1)); }
        if (e.key === "Escape") setHover(null);
      }}
    >
      {/*
       * `.an-plot` exists so the tooltip can be positioned in PERCENTAGES of
       * the drawing itself rather than of `.lchart`, whose padding would
       * otherwise offset every bubble by 18px.
       */}
      <div className="an-plot">
      {/*
       * No `preserveAspectRatio="none"`, and no inline height.
       *
       * It used to carry both: a 1000x300 viewBox was stretched into a
       * 1136x300 box, so x was scaled 1.136 and y 1.0. Every axis label and
       * date was rendered 14% too wide, and every stroke was 14% thicker
       * horizontally than vertically. `.lchart svg` in workspace.css already
       * says `width:100%;height:auto`, which scales the drawing uniformly —
       * the inline height was the only thing stopping it.
       */}
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="presentation">
        <defs>
          {/* The design's own hatch, referenced by `.lc-area`. */}
          <pattern id="lcHatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--blue)" strokeWidth="1.4" opacity=".12" />
          </pattern>
        </defs>

        <g className="lc-grid">
          {ticks.map((t) => (
            <line
              key={t.f}
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={PAD.top + plotH - t.f * plotH}
              y2={PAD.top + plotH - t.f * plotH}
            />
          ))}
          {/* The design draws verticals too — `.lc-grid line.v` — on the same
              days the axis labels fall, so a reading lines up with its date. */}
          {points.map((p, i) =>
            i > 0 && i % dateEvery === 0 ? (
              <line
                className="v"
                key={`v-${p.date}`}
                x1={x(i)}
                x2={x(i)}
                y1={PAD.top}
                y2={PAD.top + plotH}
              />
            ) : null,
          )}
        </g>

        {/*
         * The hatched area under a single line — the design's `.lc-area`, and
         * the reason the `lcHatch` pattern is defined above. Only for one
         * series in Volume mode: two overlapping washes read as a third
         * colour, and a rate has no area to speak of.
         */}
        {series.length === 1 && mode === "volume" ? (
          <path className="lc-area" d={area(points, series[0])} />
        ) : null}

        <g className="lc-ax">
          {ticks.map((t) => (
            <text
              key={t.f}
              x={PAD.left - 9}
              y={PAD.top + plotH - t.f * plotH + 4}
              textAnchor="end"
            >
              {label(t.v)}
            </text>
          ))}
          {points.map((p, i) =>
            i % dateEvery === 0 ? (
              <text key={p.date} x={x(i)} y={VIEW_H - 7} textAnchor="middle">
                {dayStamp(p.date)}
              </text>
            ) : null,
          )}
        </g>

        {/* The comparison period FIRST, so it sits under the current one. */}
        {data.compare
          ? series.map((key) => (
              <path
                key={`c-${key}`}
                className="lc-line"
                d={path(compare, key)}
                stroke={SERIES_COLOR[key]}
                strokeDasharray="5 5"
                opacity={0.35}
              />
            ))
          : null}

        {series.map((key) => (
          <path key={key} className="lc-line" d={path(points, key)} stroke={SERIES_COLOR[key]} />
        ))}

        {hover != null ? (
          <>
            <line
              className="lc-cross"
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
            />
            <g className="lc-active">
              {series.map((key) => {
                const v = value(points[hover], key, mode);
                if (v == null) return null;
                return (
                  <circle
                    key={key}
                    className="lc-dot hi"
                    cx={x(hover)}
                    cy={y(v, key)}
                    stroke={SERIES_COLOR[key]}
                  />
                );
              })}
            </g>
          </>
        ) : null}
      </svg>

      {/*
       * The bubble follows the reading.
       *
       * It used to be pinned at `top: 40`, which put it over the series chips
       * at the top of the card while the crosshair it belonged to ran 300px
       * below — two halves of one readout in two different places. Now it sits
       * just above the HIGHEST active point (smallest y), in percentages of
       * the drawing, and `left` is clamped so the bubble cannot hang outside
       * the card at the first or last day.
       */}
      {active ? (
        <div
          className="lc-tip"
          style={{
            left: `${clamp(((x(hover ?? 0)) / VIEW_W) * 100, 8, 92)}%`,
            top: `${clamp((tipY / VIEW_H) * 100, 14, 96)}%`,
          }}
        >
          <div className="day">{dayStamp(active.date)}</div>
          <div className="rows">
            {series.map((key) => {
              const v = value(active, key, mode);
              const cv = data.compare ? value(compare[hover ?? 0] ?? null, key, mode) : null;
              return (
                <div className="row" key={key}>
                  <i style={{ background: SERIES_COLOR[key] }} />
                  {SERIES[key].label}
                  <b>
                    {v == null ? "—" : mode === "rates" ? percent(v, 2) : fullNumber(v)}
                    {data.compare ? (
                      <span className="mut" style={{ fontWeight: 500 }}>
                        {" "}
                        / {cv == null ? "—" : mode === "rates" ? percent(cv, 2) : fullNumber(cv)}
                      </span>
                    ) : null}
                  </b>
                </div>
              );
            })}
          </div>
          {data.compareLabel ? (
            <div className="day" style={{ marginTop: 7 }}>
              vs {dayStamp(data.compareLabel.from)} – {dayStamp(data.compareLabel.to)}
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
}

/**
 * The series chips.
 *
 * Multi-toggle, and it never allows an empty selection — a chart with nothing
 * on it is not a state anyone chose. In Rates mode `sent` and `prospects` are
 * disabled, because a rate whose numerator is the denominator is 100%.
 */
export function SeriesChips({
  selected,
  mode,
  onChange,
}: {
  selected: SeriesKey[];
  mode: "volume" | "rates";
  onChange: (next: SeriesKey[]) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
      {(Object.keys(SERIES) as SeriesKey[]).map((key) => {
        const def = SERIES[key];
        const disabled = mode === "rates" && !def.hasRate;
        const on = selected.includes(key) && !disabled;
        return (
          <button
            key={key}
            type="button"
            className={`schip${on ? "" : " off"}`}
            disabled={disabled}
            aria-pressed={on}
            title={disabled ? `${def.label} has no rate — it is the denominator` : def.label}
            style={disabled ? { opacity: 0.3, cursor: "not-allowed" } : undefined}
            onClick={() => {
              const next = on ? selected.filter((k) => k !== key) : [...selected, key];
              // Never empty. The tool's rule, and the reason is the same: an
              // empty chart looks broken rather than deselected.
              onChange(next.length ? next : selected);
            }}
          >
            <span className="sd" style={{ background: SERIES_COLOR[key] }} />
            {def.label}
            {def.note ? <span className="mut" style={{ fontSize: 11 }}>{def.note}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
