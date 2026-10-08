/*
 * "Sales volume from / to" on a campaign's Leads tab (9 Oct).
 *
 * Pure, so the reading and the wording are tested without a browser. The
 * filtering itself happens in SQL (analytics 096, analytics_os_amount) — this
 * only turns what someone types into a number and a number back into a label.
 */

/** The lead attribute the filter reads. Generic in SQL; this is the one offered. */
export const VOLUME_ATTRIBUTE = "sales volume";

/** One-click starting points, in dollars. */
export const VOLUME_PRESETS: ReadonlyArray<{ label: string; min: number }> = [
  { label: "$1M+", min: 1_000_000 },
  { label: "$3M+", min: 3_000_000 },
  { label: "$5M+", min: 5_000_000 },
  { label: "$10M+", min: 10_000_000 },
];

/**
 * What someone typed, as dollars. "3m", "$3M", "3,000,000", "500k", "2.5M" all
 * read; blank is "no bound" (null); anything else is "invalid".
 */
export function parseAmountInput(raw: string): number | null | "invalid" {
  const s = raw.replace(/[$,\s]/g, "");
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/i.exec(s);
  if (!m) return "invalid";
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

/** $3M, $2.5M, $750K, $900 — short, for a button. */
export function shortAmount(n: number): string {
  const trim = (x: number) => String(Math.round(x * 10) / 10);
  if (n >= 1e9) return `$${trim(n / 1e9)}B`;
  if (n >= 1e6) return `$${trim(n / 1e6)}M`;
  if (n >= 1e3) return `$${trim(n / 1e3)}K`;
  return `$${n}`;
}

/** The control's label: "Sales volume", "Sales volume $3M+", "… up to $1M", "… $1M – $3M". */
export function volumeLabel(min: number | null, max: number | null): string {
  if (min === null && max === null) return "Sales volume";
  if (max === null) return `Sales volume ${shortAmount(min!)}+`;
  if (min === null) return `Sales volume up to ${shortAmount(max)}`;
  return `Sales volume ${shortAmount(min)} – ${shortAmount(max)}`;
}
