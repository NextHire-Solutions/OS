/*
 * Number filters on the Inboxes page (13 Oct: "all columns sortable /
 * filterable"). The tick-list filters in inboxes.ts cover the columns that hold
 * words — Type, Status, Tags, Vendor, Assigned. These cover the ones that hold
 * numbers: a lowest and/or a highest for each.
 *
 * A bound is what was TYPED, kept as text so a half-typed "1," or an emptied
 * box is not turned into a 0 that hides every inbox. An inbox whose value is
 * not known (a dash) fails any bound on that column: "warmup 90 or more" must
 * not list inboxes that have no warmup score at all.
 *
 * Pure, and separate from inboxes.ts so the tick filters and their tests are
 * untouched.
 */

export const RANGE_COLUMNS = [
  { key: "dailyLimit", label: "Daily limit" },
  { key: "sent", label: "Sent (all time)" },
  { key: "replied", label: "Replied (all time)" },
  { key: "bounced", label: "Bounced (all time)" },
  { key: "warmup3d", label: "Warmup (3 days)" },
  { key: "warmup7d", label: "Warmup (7 days)" },
] as const;

export type RangeKey = (typeof RANGE_COLUMNS)[number]["key"];
export type InboxRanges = Record<RangeKey, { min: string; max: string }>;

export const NO_RANGES: InboxRanges = {
  dailyLimit: { min: "", max: "" },
  sent: { min: "", max: "" },
  replied: { min: "", max: "" },
  bounced: { min: "", max: "" },
  warmup3d: { min: "", max: "" },
  warmup7d: { min: "", max: "" },
};

interface RangeRow {
  dailyLimit: number | null;
  sentAllTime: number | null;
  repliedAllTime: number | null;
  bouncedAllTime: number | null;
  warmup3d: number | null;
  warmup7d: number | null;
}

const VALUE: Record<RangeKey, (row: RangeRow) => number | null> = {
  dailyLimit: (r) => r.dailyLimit,
  sent: (r) => r.sentAllTime,
  replied: (r) => r.repliedAllTime,
  bounced: (r) => r.bouncedAllTime,
  warmup3d: (r) => r.warmup3d,
  warmup7d: (r) => r.warmup7d,
};

/** What was typed, as a number — thousands separators allowed. Null for nothing or nonsense. */
export function parseBound(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function bounds(range: { min: string; max: string }): { min: number | null; max: number | null } {
  const min = parseBound(range.min);
  const max = parseBound(range.max);
  // Typed the wrong way round: read it the way it was meant.
  return min !== null && max !== null && min > max ? { min: max, max: min } : { min, max };
}

/** How many columns have a bound in force. */
export function rangesActive(ranges: InboxRanges): number {
  return RANGE_COLUMNS.filter(({ key }) => {
    const b = bounds(ranges[key]);
    return b.min !== null || b.max !== null;
  }).length;
}

export function filterByRanges<R extends RangeRow>(rows: readonly R[], ranges: InboxRanges): R[] {
  const active = RANGE_COLUMNS.map(({ key }) => ({ key, ...bounds(ranges[key]) })).filter((b) => b.min !== null || b.max !== null);
  if (!active.length) return rows as R[];
  return rows.filter((row) =>
    active.every(({ key, min, max }) => {
      const v = VALUE[key](row);
      if (v === null) return false;
      return (min === null || v >= min) && (max === null || v <= max);
    }),
  );
}

/** "Numbers", "Numbers: Daily limit", "Numbers: 3". */
export function rangeChipLabel(ranges: InboxRanges): string {
  const on = RANGE_COLUMNS.filter(({ key }) => {
    const b = bounds(ranges[key]);
    return b.min !== null || b.max !== null;
  });
  if (on.length === 0) return "Numbers";
  if (on.length === 1) return `Numbers: ${on[0].label}`;
  return `Numbers: ${on.length}`;
}
