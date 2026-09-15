import { SERIES_KEYS, type SeriesKey } from "@/lib/tools/analytics/series.ts";

/*
 * The six series colours, as values rather than CSS variables.
 *
 * The tool's `series.ts` — copied verbatim into `lib/tools/analytics/` — names
 * each colour as `var(--series-sent)` and so on, defined in its own
 * `globals.css`. The workspace's stylesheets are not this port's to edit, so the
 * variables do not exist here and every line would have rendered as the
 * browser's default black.
 *
 * These are the tool's own hexes, lifted from `src/app/globals.css` at 6d7ebb8.
 * Keeping them here, keyed by the same `SeriesKey`, preserves the rule that
 * matters: **colour follows the entity, never the rank**. Deselecting Replies
 * must not repaint Human, because a screenshot taken last quarter has to still
 * mean what it meant.
 *
 * The set was validated for lightness/chroma separation and for
 * distinguishability under colour-vision deficiency. `human` sits below the 3:1
 * contrast floor against the page surface, which is why every series is ALSO
 * labelled — in its chip and in the crosshair tooltip. Colour is never the only
 * channel carrying the identity.
 */
export const SERIES_COLOR: Record<SeriesKey, string> = {
  sent: "#2a78d6",
  replies: "#eb6834",
  human: "#1baf7a",
  positive: "#008300",
  prospects: "#4a3aa7",
  bounces: "#e34948",
};

/** Every series in registry order — the chip row and the legend share it. */
export const SERIES_ORDER: readonly SeriesKey[] = SERIES_KEYS;

/*
 * The three sending platforms an outcome can come from.
 *
 * Same values the tool's coverage strip uses. `direct` is grey on purpose: it
 * is the absence of a platform, not a third one.
 */
export const PLATFORM_COLOR: Record<string, string> = {
  emailbison: "#2a78d6",
  instantly: "#4a3aa7",
  direct: "#94a3b8",
};

/*
 * The bounce bands, and where the thresholds are.
 *
 * Duplicated from `analytics_sender_rows` / `analytics_sender_groups` /
 * `analytics_sender_bands` in SQL, exactly as the tool duplicates them in
 * `infrastructure-view.tsx`. If one moves, both must.
 */
export const BOUNCE_WATCH = 0.02;
export const BOUNCE_HIGH = 0.03;
/** The meter tops out here, so a 40% inbox does not flatten every other bar. */
export const BOUNCE_METER_CEILING = 0.05;

export function bounceTone(rate: number | null): string {
  if (rate == null) return "var(--muted)";
  if (rate >= BOUNCE_HIGH) return "var(--red)";
  if (rate >= BOUNCE_WATCH) return "var(--yellow)";
  return "var(--muted)";
}

export const BAND_LABEL: Record<string, string> = {
  high: "Critical",
  watch: "Watch",
  ok: "Healthy",
  unsent: "Never sent",
};

/*
 * The bar colours.
 *
 * `ok` is GREY, not green — the design's own choice, and the right one: a
 * healthy domain is the absence of a problem, not an achievement, and a green
 * block 95% as wide as the bar draws the eye to the part with nothing to say.
 * The severity ramp is then grey → amber → red, reading left to right.
 */
export const BAND_COLOR: Record<string, string> = {
  high: "#C93A31",
  watch: "#B45309",
  ok: "#B9C0CB",
  unsent: "#DDE1E7",
};

/** Label ink. Darker than the bar so 12px text stays legible on white. */
export const BAND_INK: Record<string, string> = {
  high: "#C93A31",
  watch: "#B45309",
  ok: "#7A8394",
  unsent: "#7A8394",
};

/** Where each band's threshold sits, shown beside its name. */
export const BAND_RANGE: Record<string, string> = {
  ok: "under 2%",
  watch: "2%–3%",
  high: "over 3%",
  unsent: "no sends",
};

/**
 * Severity order, so the bar ramps rather than landing in whatever order the
 * query returned — which was alphabetical, putting Critical first.
 */
export const BAND_ORDER: Record<string, number> = {
  ok: 0,
  watch: 1,
  high: 2,
  unsent: 3,
};
