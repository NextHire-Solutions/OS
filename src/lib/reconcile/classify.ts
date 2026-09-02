import type {
  Comparison,
  Concept,
  DivergenceKind,
  Reading,
  SourceSpec,
} from "./types";

/*
 * Deciding whether a disagreement is worth anyone's attention.
 *
 * The whole value of this screen rests on the difference between "these two
 * numbers differ because they answer different questions" and "these two
 * numbers differ and nobody knows why". If it flags the first kind, people stop
 * reading it within a week and we are back to tickets.
 *
 * So the ladder below is ordered from least to most alarming, and a difference
 * is only ever called `unexplained` once every benign explanation has been
 * ruled out structurally.
 */

const WINDOW_LABEL: Record<SourceSpec["window"], string> = {
  "all-time": "all time",
  "30d": "the last 30 days",
  "iso-week": "this week (Monday-start)",
  current: "right now",
};

export function compare(
  concept: Concept,
  readings: Reading[],
  specs: SourceSpec[],
): Comparison {
  const available = readings.filter(
    (r): r is Reading & { value: number } => typeof r.value === "number",
  );

  const base = {
    concept: concept.id,
    label: concept.label,
    question: concept.question,
    readings,
  };

  // Fewer than two numbers is not agreement — there is simply nothing to
  // compare. Reporting "agree" here would be the most misleading thing this
  // module could do: a green tick that means "we could not check".
  if (available.length < 2) {
    const missing = readings.filter((r) => r.value === null);
    return {
      ...base,
      spread: null,
      divergence: "insufficient",
      verdict:
        available.length === 0
          ? "No source could answer this."
          : `Only one source answered. ${describeMissing(missing)}`,
    };
  }

  const values = available.map((r) => r.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const delta = max - min;
  const relative = max === 0 ? 0 : delta / max;

  const spread = { min, max, delta, relative };

  if (relative <= concept.tolerance) {
    return {
      ...base,
      spread,
      divergence: "agree",
      verdict:
        delta === 0
          ? "All sources agree."
          : `Sources agree within ${pct(concept.tolerance)} (${delta.toLocaleString("en-US")} apart).`,
    };
  }

  // Ruled out in this order because a window mismatch is the coarser
  // explanation: if two sources cover different periods, comparing their
  // platform coverage tells you nothing useful.
  const specsFor = (r: Reading) =>
    specs.find((s) => s.tool === r.tool && s.key === r.key);

  const windows = new Set(available.map((r) => specsFor(r)?.window).filter(Boolean));
  if (windows.size > 1) {
    const described = [...windows].map((w) => WINDOW_LABEL[w as SourceSpec["window"]]);
    return {
      ...base,
      spread,
      divergence: "window",
      verdict: `Expected. These cover different periods — ${listOf(described)} — so they should not match.`,
    };
  }

  const platformSets = available.map((r) => (specsFor(r)?.platforms ?? []).join("+"));
  if (new Set(platformSets).size > 1) {
    const widest = widestPlatformSet(available, specsFor);
    return {
      ...base,
      spread,
      divergence: "definition",
      verdict: `Expected. These count different platforms${
        widest ? ` — ${widest} sees more than the others` : ""
      }, so the totals should differ.`,
    };
  }

  // Same period, same platforms, still apart. This is the only case worth
  // investigating, and the only one that should ever look alarming.
  return {
    ...base,
    spread,
    divergence: "unexplained",
    verdict: `Worth a look. Same period and same platforms, yet ${delta.toLocaleString(
      "en-US",
    )} apart (${pct(relative)}).`,
  };
}

function widestPlatformSet(
  readings: Reading[],
  specsFor: (r: Reading) => SourceSpec | undefined,
): string | null {
  let best: { label: string; size: number } | null = null;
  for (const r of readings) {
    const spec = specsFor(r);
    if (!spec) continue;
    if (!best || spec.platforms.length > best.size) {
      best = { label: r.label, size: spec.platforms.length };
    }
  }
  return best?.label ?? null;
}

function describeMissing(missing: Reading[]): string {
  if (missing.length === 0) return "";
  const reasons = missing
    .map((r) => `${r.label} (${r.unavailable ?? "unavailable"})`)
    .slice(0, 3);
  return `Missing: ${reasons.join("; ")}.`;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Tally for the headline. Every kind is present, so a zero renders as a zero. */
export function summarise(comparisons: Comparison[]): Record<DivergenceKind, number> {
  const summary: Record<DivergenceKind, number> = {
    agree: 0,
    window: 0,
    definition: 0,
    unexplained: 0,
    insufficient: 0,
  };
  for (const c of comparisons) summary[c.divergence]++;
  return summary;
}
