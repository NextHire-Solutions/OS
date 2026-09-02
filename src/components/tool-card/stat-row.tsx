import { compactNumber, duration, percent, relativeTime, DASH } from "@/lib/format";
import type { ToolMetric } from "@/lib/connectors/types";

/*
 * Stats without boxes.
 *
 * The previous version divided the numbers into hairline columns, borrowing
 * the KPI-band pattern from the Analytics app. That works there, where twelve
 * dense metrics genuinely form an instrument panel. Here each card has one or
 * two numbers, and the dividers made that thinness look like a broken table.
 *
 * So: no rules, no cells. Just numbers with labels under them, spaced. When a
 * tool has nothing to report the row simply doesn't render, and the card's
 * description carries it — which is why the description is now the subtitle
 * instead of a truncated Railway hostname.
 */

function render(metric: ToolMetric): string {
  const { value, format } = metric;
  if (value === null || value === undefined) return DASH;

  const asNumber = typeof value === "number" ? value : null;

  switch (format) {
    case "percent":
      return percent(asNumber);
    case "duration":
      return duration(asNumber);
    case "relative-time":
      return relativeTime(typeof value === "string" ? value : null);
    case "text":
      return String(value);
    default:
      return compactNumber(asNumber);
  }
}

export function StatRow({ metrics }: { metrics: ToolMetric[] }) {
  // Two is the cap. A third number on a card this size stops being scannable
  // and starts being a report.
  const shown = metrics.slice(0, 2);
  if (shown.length === 0) return null;

  return (
    <div className="flex items-start gap-6">
      {shown.map((metric) => {
        const value = render(metric);
        const isDash = value === DASH;

        return (
          <div key={metric.key} className="min-w-0">
            <div
              data-metric
              title={metric.hint}
              className={`truncate text-[19px] font-semibold leading-none tracking-[-0.015em] ${
                isDash ? "text-muted-foreground" : "text-foreground"
              }`}
            >
              {value}
            </div>
            <div className="mt-1.5 truncate text-[11px] leading-none text-muted-foreground">
              {metric.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
