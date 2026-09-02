/*
 * Every rendering rule in one place. Ported from the Analytics app's
 * lib/analytics/format.ts so a number formatted here reads identically to the
 * same number formatted there — this dashboard sits above those tools and
 * must not disagree with them about what "272.4K" looks like.
 *
 * DASH is the important one. Every formatter returns it for null/undefined/
 * non-finite input, and it is the ONLY way an unknown metric reaches the DOM.
 * That keeps `0` and "we couldn't ask" visually distinct everywhere for free,
 * which matters more here than in any single tool: half these cards are
 * reporting on upstreams that routinely can't answer.
 */

export const DASH = "-";

type Numeric = number | null | undefined;

function isNumber(value: Numeric): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Card number. Compacts at 1,000 with one decimal: `3.7K`, `272.4K`, `1.2M`. */
export function compactNumber(value: Numeric): string {
  if (!isNumber(value)) return DASH;

  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  if (abs < 1_000) return `${sign}${abs.toLocaleString("en-US")}`;
  if (abs < 1_000_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  if (abs < 1_000_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
}

/** Exact, with locale grouping: `272,389`. */
export function fullNumber(value: Numeric): string {
  if (!isNumber(value)) return DASH;
  return value.toLocaleString("en-US");
}

/** A rate expressed as a fraction (0.0135) rendered as `1.4%`. */
export function percent(value: Numeric, digits = 1): string {
  if (!isNumber(value)) return DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Duration in SECONDS, auto-unit with one decimal.
 * Sub-minute values still render as minutes (`0.3m`) — a reply time of "18s"
 * is noise, not signal, at this altitude.
 */
export function duration(seconds: Numeric): string {
  if (!isNumber(seconds) || seconds < 0) return DASH;

  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;

  if (days >= 1) return `${days.toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${minutes.toFixed(1)}m`;
}

/** `12s ago`, `4m ago`, `3h ago`, `2d ago`. Null-safe. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return DASH;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return DASH;

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Bare hostname for the card subtitle — the "which environment" tell. */
export function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface Delta {
  label: string;
  tone: "up" | "down" | "flat";
}

/**
 * Period-over-period change as a fraction. Returns a tone alongside the label
 * because the CALLER decides whether up is good — a rise in Bounces is not a
 * green number, and encoding that here would put product judgement in a
 * formatter.
 */
export function delta(value: Numeric): Delta | null {
  if (!isNumber(value)) return null;
  const rounded = Number((value * 100).toFixed(1));
  if (rounded === 0) return { label: "0%", tone: "flat" };
  return {
    label: `${rounded > 0 ? "+" : ""}${rounded}%`,
    tone: rounded > 0 ? "up" : "down",
  };
}
