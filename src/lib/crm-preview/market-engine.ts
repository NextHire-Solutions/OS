/*
 * The new portal's Market, answered from memory (26 Oct — the user: "the
 * agent data needs to load faster … clients need to be able to see the data
 * instantly as new filters are being applied").
 *
 * WHY. Every filter change asked the agent database's fn_filter_search, which
 * counts and totals the whole matching market each time: 1.8 – 3.6 s for the
 * Demo's 102,659 salespeople, the same on a repeat. Held in memory, the same
 * answer is a few milliseconds.
 *
 * THE SAME ANSWER, NOT A SIMILAR ONE. This is a port of exactly the parts of
 * the Database app's fn_agent_where / fn_filter_search the Market sends
 * (Database migrations 0035, 0037, 0064, 0109, 0119): same keys, same NULL
 * rules, same order and tie-break. Anything else — a filter it does not
 * know, a market not scoped per MLS, the search box, a text order (name,
 * brokerage, city — the database's collation is not JavaScript's), a value
 * with characters beyond plain ASCII — answers null and the request goes to
 * the database as before (audit, 26 Oct). And a market is only
 * ever answered from memory after it has matched the database on a set of
 * real queries (market-memory.ts parity).
 *
 * Pure: no database, no clock — tested in market-engine.test.ts.
 */

/** One agent of a market, with the numbers the database shows, sorts and filters by. */
export interface MemAgent {
  id: string;
  full_name: string | null;
  title: string | null;
  brand: string | null;
  office_name: string | null;
  office_city: string | null;
  office_state: string | null;
  office_county: string | null;
  office_city_key: string | null;
  most_transacted_city: string | null;
  transacted_state: string | null;
  most_transacted_county: string | null;
  most_transacted_city_key: string | null;
  /** Scoped: the sum over the market's MLSs (agent_mls_stats), null when the agent has no stats there. */
  sales_volume: number | null;
  units: number | null;
  est_time_in_industry_months: number | null;
  preferred_email: string | null;
  enriched_email: string | null;
}

export interface MemMarket {
  /** The market's MLS ids, sorted. */
  mlsIds: string[];
  /** Salespeople only — the market's base (marketScope) — in no particular order. */
  agents: MemAgent[];
  /** The agents in each order already asked for ("sales_volume:desc"), sorted once — a search then only filters. */
  sorted?: Map<string, MemAgent[]>;
}

export interface MemResult {
  rows: MemAgent[];
  total: number;
  salesVolume: number;
}

/** The title the market is (market-model MARKET_TITLE). */
export const MARKET_TITLE_TOKEN = "salesperson";

/* --------------------------------------------------- the database's helpers --- */

/** fn_city_match_key (Database 0035). */
export function cityMatchKey(p: string | null | undefined): string | null {
  let s = (p ?? "").trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "");
  s = s.split(",")[0];
  s = s.replace(/\s+\d{5}(-\d{4})?$/, "");
  s = s.replace(/[\s.,;:]+$/, "");
  s = s.replace(/\s+/g, " ");
  s = s.trim().toLowerCase();
  return s || null;
}

const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA MD ME MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split(" "));

/** fn_city_embedded_state (Database 0037): a trailing ", ST" on a raw city. */
export function cityEmbeddedState(p: string | null | undefined): string | null {
  // ASCII whitespace only: Postgres's \s (glibc) is not JavaScript's, which also matches a no-break space.
  const m = /,[ \t\n\v\f\r]*([A-Za-z]{2})[ \t\n\v\f\r]*$/.exec(p ?? "");
  const u = m ? m[1].toUpperCase() : null;
  return u && US_STATES.has(u) ? u : null;
}

/** fn_title_tokens (Database 0079): comma-separated, lower-cased, letters and digits only. */
export function titleTokens(t: string | null | undefined): string[] {
  if (t === null || t === undefined) return [];
  return t.split(",").map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

const STATE_SUFFIX = /,\s*([A-Za-z]{2})\s*$/;

/* ------------------------------------------------------------- the filters --- */

type Filters = Record<string, unknown>;
type Pred = (a: MemAgent) => boolean;
const UNSUPPORTED: unique symbol = Symbol("unsupported");

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const bound = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** fn_range_cond on a value (min/max inclusive; NULL never passes once a bound is set). */
function range(f: unknown, value: (a: MemAgent) => number | null, scale = 1): Pred | null | typeof UNSUPPORTED {
  if (!isObj(f)) return null;
  if (strs(f.buckets).length) return UNSUPPORTED;
  if ((f.side ?? "all") !== "all") return UNSUPPORTED;
  const min = bound(f.min);
  const max = bound(f.max);
  if (Number.isNaN(min) || Number.isNaN(max)) return UNSUPPORTED;
  if (min === null && max === null) return null;
  const lo = min === null ? null : min * scale;
  const hi = max === null ? null : max * scale;
  return (a) => {
    const v = value(a);
    if (v === null) return false;
    return (lo === null || v >= lo) && (hi === null || v <= hi);
  };
}

/** officeSearch's brand or office: include = one of; exclude = NULL or none of. */
function org(f: unknown, col: (a: MemAgent) => string | null): Pred[] | typeof UNSUPPORTED {
  if (f === undefined || f === null) return [];
  if (!isObj(f)) return UNSUPPORTED;
  const out: Pred[] = [];
  const inc = new Set(strs(f.include));
  const exc = new Set(strs(f.exclude));
  if (inc.size) out.push((a) => { const v = col(a); return v !== null && inc.has(v); });
  if (exc.size) out.push((a) => { const v = col(a); return v === null || !exc.has(v); });
  return out;
}

const KIND_COLS = {
  office: { key: (a: MemAgent) => a.office_city_key, city: (a: MemAgent) => a.office_city, state: (a: MemAgent) => a.office_state, county: (a: MemAgent) => a.office_county },
  transacted: { key: (a: MemAgent) => a.most_transacted_city_key, city: (a: MemAgent) => a.most_transacted_city, state: (a: MemAgent) => a.transacted_state, county: (a: MemAgent) => a.most_transacted_county },
} as const;

/** One side of a location filter (values or excludeValues): does the agent match ANY of its conditions. */
/** Plain printable ASCII only: JavaScript's and Postgres's trim / \\s / lower agree there, and nowhere else is promised. */
const PLAIN = /^[\x20-\x7E]*$/;

/** One side's match — or null when its values give no condition at all (the SQL then adds none: no filter). */
function placeMatcher(values: unknown[], defaultField: string, kinds: Array<keyof typeof KIND_COLS>): ((a: MemAgent) => boolean) | null | typeof UNSUPPORTED {
  // Grouped by level, as the database does: { f, v } objects carry their own; plain strings use the side's field.
  const groups = new Map<string, string[]>();
  for (const e of values) {
    let f = defaultField;
    let v: string;
    if (isObj(e)) {
      if (typeof e.f === "string" && e.f) f = e.f;
      if (typeof e.v !== "string") return UNSUPPORTED;
      v = e.v;
    } else if (typeof e === "string") v = e;
    else return UNSUPPORTED;
    if (!PLAIN.test(v) || v.includes("\\")) return UNSUPPORTED;
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f)!.push(v);
  }
  const conds: Array<(a: MemAgent) => boolean> = [];
  for (const [ef, vals] of groups) {
    if (ef !== "city" && ef !== "county" && ef !== "state") return UNSUPPORTED;
    for (const kind of kinds) {
      const c = KIND_COLS[kind];
      if (ef === "state") {
        const set = new Set(vals.map((v) => v.toUpperCase()));
        conds.push((a) => { const s = c.state(a); return s !== null && set.has(s.toUpperCase()); });
        continue;
      }
      const keyOf = (v: string) => (ef === "city" ? cityMatchKey(v) : v.trim().toLowerCase());
      // Values with no ", ST": the key alone.
      const bare = new Set(vals.filter((v) => !STATE_SUFFIX.test(v)).map(keyOf).filter((k): k is string => !!k));
      if (bare.size) {
        conds.push(ef === "city"
          ? (a) => { const k = c.key(a); return k !== null && bare.has(k); }
          : (a) => { const k = c.county(a); return k !== null && bare.has(k.toLowerCase()); });
      }
      // Values with a state: the key AND the state (a city's state falls back to one embedded in its name; a county's does not).
      const byState = new Map<string, Set<string>>();
      for (const v of vals) {
        const m = STATE_SUFFIX.exec(v);
        if (!m) continue;
        const st = m[1].toUpperCase();
        const k = keyOf(v.replace(/,\s*[A-Za-z]{2}\s*$/, "").trim());
        if (!byState.has(st)) byState.set(st, new Set());
        if (k) byState.get(st)!.add(k);
      }
      for (const [st, keys] of byState) {
        if (!keys.size) continue;
        conds.push(ef === "city"
          ? (a) => {
              const k = c.key(a);
              if (k === null || !keys.has(k)) return false;
              const s = c.state(a);
              return (s !== null ? s.toUpperCase() : cityEmbeddedState(c.city(a))) === st;
            }
          : (a) => {
              const k = c.county(a);
              if (k === null || !keys.has(k.toLowerCase())) return false;
              const s = c.state(a);
              return s !== null && s.toUpperCase() === st;
            });
      }
    }
  }
  if (!conds.length) return null;
  return (a) => conds.some((p) => p(a));
}

function location(f: unknown): Pred[] | typeof UNSUPPORTED {
  if (f === undefined || f === null) return [];
  if (!isObj(f)) return UNSUPPORTED;
  const kindsRaw = f.appliesTo === undefined ? ["office", "home", "transacted"] : strs(f.appliesTo);
  if (kindsRaw.some((k) => k !== "office" && k !== "transacted")) return UNSUPPORTED; // home is not held
  const kinds = kindsRaw as Array<keyof typeof KIND_COLS>;
  const out: Pred[] = [];
  const field = typeof f.field === "string" && f.field ? f.field : "city";
  const inc = Array.isArray(f.values) ? f.values : [];
  if (inc.length) {
    const m = placeMatcher(inc, field, kinds);
    if (m === UNSUPPORTED) return UNSUPPORTED;
    if (m) out.push(m);
  }
  const exc = Array.isArray(f.excludeValues) ? f.excludeValues : [];
  if (exc.length) {
    const exField = typeof f.excludeField === "string" && f.excludeField ? f.excludeField : field;
    const m = placeMatcher(exc, exField, kinds);
    if (m === UNSUPPORTED) return UNSUPPORTED;
    // NOT EXISTS: an agent with no place at all is kept.
    if (m) out.push((a) => !m(a));
  }
  return out;
}

/**
 * The market's filters as one predicate — or UNSUPPORTED for anything this
 * does not reproduce exactly. The base must be exactly the market: these MLSs
 * (all scoped), salespeople.
 */
function compile(filters: Filters, market: MemMarket): Pred | typeof UNSUPPORTED {
  const KNOWN = new Set(["mls", "title", "salesVolume", "closedUnits", "estTimeInIndustry", "officeSearch", "location", "nameQuery"]);
  for (const k of Object.keys(filters)) if (!KNOWN.has(k)) return UNSUPPORTED;

  const mls = filters.mls;
  if (!isObj(mls) || strs(mls.exclude).length) return UNSUPPORTED;
  const inc = [...strs(mls.include)].sort();
  if (inc.length !== market.mlsIds.length || inc.some((id, i) => id !== market.mlsIds[i])) return UNSUPPORTED;

  const title = filters.title;
  if (!isObj(title) || strs(title.exclude).length) return UNSUPPORTED;
  const tInc = [...new Set(strs(title.include).map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "")))];
  if (tInc.length !== 1 || tInc[0] !== MARKET_TITLE_TOKEN) return UNSUPPORTED;

  const preds: Pred[] = [];
  const ranges: Array<Pred | null | typeof UNSUPPORTED> = [
    range(filters.salesVolume, (a) => a.sales_volume),
    range(filters.closedUnits, (a) => a.units),
    range(filters.estTimeInIndustry, (a) => a.est_time_in_industry_months, 12),
  ];
  for (const r of ranges) {
    if (r === UNSUPPORTED) return UNSUPPORTED;
    if (r) preds.push(r);
  }
  const os = filters.officeSearch;
  if (os !== undefined) {
    if (!isObj(os)) return UNSUPPORTED;
    const orgs: Array<Pred[] | typeof UNSUPPORTED> = [org(os.brand, (a) => a.brand), org(os.office, (a) => a.office_name)];
    for (const p of orgs) {
      if (p === UNSUPPORTED) return UNSUPPORTED;
      preds.push(...p);
    }
  }
  const loc = location(filters.location);
  if (loc === UNSUPPORTED) return UNSUPPORTED;
  preds.push(...loc);
  return (a) => preds.every((p) => p(a));
}

/* ---------------------------------------------------------------- the order --- */

/*
 * THE ORDER. Only the market's own numbers — volume and units, which a
 * scoped market sorts by its MLS sums with nulls last and the agent id to
 * break ties (fn_filter_search 0119), exactly reproducible. A text order
 * (name, brokerage, city, title) depends on the database's collation, which
 * JavaScript's is not — those go to the database. So does the search box:
 * under these two orders the database ignores it anyway, and any other
 * order is a text one.
 */
const MEMORY_SORTS = new Set(["sales_volume", "units"]);

function comparator(sortBy: string, dir: "asc" | "desc"): ((x: MemAgent, y: MemAgent) => number) | typeof UNSUPPORTED {
  if (!MEMORY_SORTS.has(sortBy)) return UNSUPPORTED;
  const sign = dir === "asc" ? 1 : -1;
  const get = (a: MemAgent) => (sortBy === "units" ? a.units : a.sales_volume);
  return (x, y) => {
    const a = get(x);
    const b = get(y);
    if (a !== b) {
      if (a === null) return 1; // nulls last, either way
      if (b === null) return -1;
      return (a < b ? -1 : 1) * sign;
    }
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  };
}

/**
 * One page of the market, as fn_filter_search answers it — or null when this
 * request is not one the memory reproduces exactly (the caller asks the
 * database instead).
 */
export function searchMarket(
  market: MemMarket,
  filters: Filters,
  sort: { by: string; dir: "asc" | "desc" },
  limit: number,
  offset: number,
): MemResult | null {
  const pred = compile(filters, market);
  if (pred === UNSUPPORTED) return null;
  // The search box: the database's (its scoped order ignores it — but it is not ours to assume).
  if (typeof filters.nameQuery === "string" && filters.nameQuery !== "") return null;
  const cmp = comparator(sort.by, sort.dir);
  if (cmp === UNSUPPORTED) return null;
  // The market in this order, sorted once and kept: a search then only filters.
  const key = `${sort.by}:${sort.dir}`;
  market.sorted ??= new Map();
  let order = market.sorted.get(key);
  if (!order) {
    order = [...market.agents].sort(cmp);
    market.sorted.set(key, order);
  }
  const want = Math.max(limit, 1);
  const rows: MemAgent[] = [];
  let total = 0;
  // In whole cents: a sum of 100,000 dollar amounts in floating point drifts by more than a cent.
  let cents = 0;
  const take = (a: MemAgent) => {
    if (!pred(a)) return;
    if (total >= offset && rows.length < want) rows.push(a);
    total++;
    if (a.sales_volume !== null) cents += Math.round(a.sales_volume * 100);
  };
  for (const a of order) take(a);
  return { rows, total, salesVolume: cents / 100 };
}
