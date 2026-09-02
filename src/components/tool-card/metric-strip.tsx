import { cn } from "@/lib/utils";
import { compactNumber, duration, percent, relativeTime, DASH } from "@/lib/format";
import type { ToolMetric, ToolSnapshot } from "@/lib/connectors/types";

/*
 * The metric strip: hairline-divided columns, NOT a row of little boxes.
 *
 * This is the KPI-band idea from the Analytics app shrunk to card scale —
 * bordered boxes read as separate things, hairlines read as one instrument.
 *
 * Three metrics is the cap. Four 20px numbers in a 386px card gives each
 * column 89px, which truncates a label like "Median reply" and makes the card
 * feel like a report instead of a glance.
 */

function renderValue(m: ToolMetric): string {
  if (m.value === null || m.value === undefined) return DASH;

  switch (m.format) {
    case "compact":
      return compactNumber(typeof m.value === "number" ? m.value : null);
    case "percent":
      return percent(typeof m.value === "number" ? m.value : null);
    case "duration":
      return duration(typeof m.value === "number" ? m.value : null);
    case "relative-time":
      return relativeTime(typeof m.value === "string" ? m.value : null);
    case "text":
      return String(m.value);
    default:
      return compactNumber(typeof m.value === "number" ? m.value : null);
  }
}

const INTENT_DOT: Record<string, string> = {
  warn: "bg-status-warn",
  bad: "bg-status-down",
  good: "bg-status-up",
};

function Metric({ metric, columns }: { metric: ToolMetric; columns: number }) {
  const value = renderValue(metric);
  const isDash = value === DASH;
  // A dot only when the intent is actually actionable AND the number is
  // non-zero. `0 needs reply` is a real, good, measured value; flagging it
  // amber would cry wolf.
  const showDot =
    metric.intent &&
    metric.intent !== "neutral" &&
    typeof metric.value === "number" &&
    metric.value > 0 &&
    metric.intent !== "good";

  return (
    <div className={cn("min-w-0 px-4 first:pl-5 last:pr-5", columns > 1 && "not-first:hairline-x")}>
      <div className="flex items-center gap-1.5">
        {showDot ? (
          <span
            className={cn("size-1.5 shrink-0 rounded-full", INTENT_DOT[metric.intent!])}
            aria-hidden="true"
          />
        ) : null}
        <span className="truncate text-[11px] leading-none text-muted-foreground">
          {metric.label}
        </span>
      </div>
      <div
        data-metric
        title={metric.hint}
        className={cn(
          "mt-1.5 truncate font-semibold leading-tight",
          // A text value ("brightdata") is a label, not a measurement. At the
          // numeric size it shouts louder than the numbers it sits beside.
          metric.format === "text" ? "text-[15px]" : "text-[20px]",
          isDash ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Fixed-height region with a fallback ladder, never an empty box and never
 * padded with placeholder metrics. A card whose truthful content is short
 * should say less — filling the Database card with three em-dashes would
 * imply data that failed to load, which is a different and wrong claim.
 */
export function MetricStrip({ snapshot }: { snapshot: ToolSnapshot }) {
  const metrics = snapshot.metrics.slice(0, 3);

  if (metrics.length > 0) {
    return (
      <div
        className="grid h-16 items-center border-y border-hairline"
        style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}
      >
        {metrics.map((m) => (
          <Metric key={m.key} metric={m} columns={metrics.length} />
        ))}
      </div>
    );
  }

  // No metrics by design (a black box) — state the capability honestly.
  if (!snapshot.capabilities.hasMetrics) {
    return (
      <div className="flex h-16 flex-col justify-center border-y border-hairline px-5">
        <p className="text-[13px] text-foreground-secondary">
          {snapshot.reachable
            ? `Reachable${snapshot.latencyMs !== null ? ` · ${snapshot.latencyMs} ms` : ""}`
            : "Status not exposed"}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Checked {relativeTime(snapshot.checkedAt)}
        </p>
      </div>
    );
  }

  // Has a metrics probe, but it produced nothing this round.
  return (
    <div className="flex h-16 flex-col justify-center border-y border-hairline px-5">
      <p className="text-[13px] text-muted-foreground">Metrics unavailable</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Checked {relativeTime(snapshot.checkedAt)}
      </p>
    </div>
  );
}
