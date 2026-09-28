/*
 * A client's markets — the rule, with no database attached.
 *
 * A client covers MANY (market, MLS, area) combinations. The client's own words:
 *
 *     "one client can cover multiple Markets, MLS and Area hence have multiple
 *      campaigns and 1 or multiple portals"
 *
 * Pure on purpose, for the same reason `onboard-plan.ts` is: the interesting
 * part is which rows are valid and which collide, and that should be testable
 * without four database connections. The I/O lives in `markets-db.ts`.
 *
 * ---------------------------------------------------------------------------
 * ONE NORMALISATION, MATCHING THE UNIQUE INDEX EXACTLY
 *
 * Migration 0017's unique index is:
 *
 *     (client_id, lower(btrim(market)), coalesce(lower(btrim(mls)), ''),
 *                                      coalesce(lower(btrim(area)), ''))
 *
 * `marketKey()` below is that expression in TypeScript. It has to stay
 * byte-compatible: if it drifts, the UI accepts a row the database then
 * rejects with a constraint violation, which is the worst of both — the user
 * sees a Postgres error for something we could have told them plainly.
 *
 * MLS and area are optional, so NULL is the COMMON case, not an edge one. That
 * is why blank collapses to null in one place (`clean`) and the key folds null
 * to '' in another: two different jobs that are easy to conflate.
 */

/** A market row as the UI submits it. Ids are absent until it is saved. */
export interface MarketInput {
  market: string;
  mls?: string | null;
  area?: string | null;
}

/** A saved market row. */
export interface MarketRow extends MarketInput {
  id: string;
  mls: string | null;
  area: string | null;
}

/** What a market row looks like once cleaned: trimmed, blanks made null. */
export interface CleanMarket {
  market: string;
  mls: string | null;
  area: string | null;
}

export const MARKET_MAX = 120;

/**
 * Trim everything, and turn a blank optional field into null.
 *
 * "" and "   " must both mean "not set" rather than "the empty MLS", because a
 * form submits an untouched text input as "". Storing that would create a row
 * the unique index treats as identical to a null one while the UI shows them
 * as different.
 */
export function clean(input: MarketInput): CleanMarket {
  const blankToNull = (v: string | null | undefined): string | null => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  };
  return {
    market: (input.market ?? "").trim(),
    mls: blankToNull(input.mls),
    area: blankToNull(input.area),
  };
}

/**
 * The database's unique-index expression, in TypeScript.
 *
 * Must stay identical to migration 0017's index. The test file pins the cases
 * that matter: case, surrounding space, and null vs blank.
 */
export function marketKey(input: MarketInput): string {
  const c = clean(input);
  const fold = (v: string | null) => (v ?? "").toLowerCase();
  return [c.market.toLowerCase(), fold(c.mls), fold(c.area)].join("\u0000");
}

export type MarketProblem =
  | { field: "market"; message: string }
  | { field: "mls"; message: string }
  | { field: "area"; message: string }
  | { field: "row"; message: string };

/**
 * Why this row cannot be saved, or null when it can.
 *
 * `existing` is the client's other market rows. A row that duplicates one of
 * them is refused HERE, with the name of the thing it clashes with, rather than
 * left to the unique index — a 23505 from Postgres tells the user nothing about
 * which of their rows was already there.
 */
export function validateMarket(
  input: MarketInput,
  existing: MarketRow[] = [],
  /** Set when editing, so a row does not collide with itself. */
  ignoreId?: string,
): MarketProblem | null {
  const c = clean(input);

  if (!c.market) return { field: "market", message: "A market is required." };
  if (c.market.length > MARKET_MAX) {
    return { field: "market", message: `A market cannot be longer than ${MARKET_MAX} characters.` };
  }
  for (const [field, value] of [["mls", c.mls], ["area", c.area]] as const) {
    if (value && value.length > MARKET_MAX) {
      return { field, message: `The ${field === "mls" ? "MLS" : "area"} cannot be longer than ${MARKET_MAX} characters.` };
    }
  }

  const key = marketKey(c);
  const clash = existing.find((r) => r.id !== ignoreId && marketKey(r) === key);
  if (clash) {
    const parts = [clash.market, clash.mls, clash.area].filter(Boolean).join(" · ");
    return { field: "row", message: `This client already covers ${parts}.` };
  }
  return null;
}

/**
 * How a market reads on one line: "Boston · MLS PIN · Suffolk County".
 *
 * Used by the screen and by the delete confirmation, so both name a row the
 * same way — a confirmation that describes the row differently from the list it
 * was clicked in is how people delete the wrong one.
 */
export function marketLabel(row: MarketInput): string {
  const c = clean(row);
  return [c.market, c.mls, c.area].filter(Boolean).join(" · ");
}

/**
 * The client's markets in display order: by market, then MLS, then area, all
 * case-insensitive.
 *
 * Sorted here rather than in SQL so the list cannot reorder under the user
 * between a local edit and the next fetch.
 */
export function sortMarkets<T extends MarketInput>(rows: T[]): T[] {
  const cmp = (a: string | null, b: string | null) =>
    (a ?? "").toLowerCase().localeCompare((b ?? "").toLowerCase());
  return [...rows].sort(
    (x, y) => cmp(x.market, y.market) || cmp(x.mls ?? null, y.mls ?? null) || cmp(x.area ?? null, y.area ?? null),
  );
}

/**
 * Distinct values already in use across every client, for the datalist the Add
 * dialog offers.
 *
 * Same reasoning as 0015's "names, not foreign keys": these are free text, so
 * the defence against typos is making the existing spelling one click away.
 * Sorted, de-duplicated case-insensitively, first spelling wins.
 */
export function suggestionsFrom(rows: MarketInput[]): {
  markets: string[];
  mlses: string[];
  areas: string[];
} {
  const pick = (get: (r: MarketInput) => string | null | undefined) => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      const v = (get(r) ?? "").trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (!seen.has(k)) seen.set(k, v);
    }
    return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  };
  return {
    markets: pick((r) => r.market),
    mlses: pick((r) => r.mls),
    areas: pick((r) => r.area),
  };
}
