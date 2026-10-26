import "server-only";

import { readOnly } from "@/lib/tools/assistant/read-only";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

import { MARKET_TITLE_TOKEN, searchMarket, titleTokens, type MemAgent, type MemMarket, type MemResult } from "./market-engine";

/*
 * The market held in memory (market-engine.ts says why and how it answers).
 *
 * LOADING. In the background, the first time a portal's Market is asked for:
 * the market's agents (agent_mls → agents) and their per-MLS numbers
 * (agent_mls_stats), read in 16 slices by agent id, four at a time — the
 * agent database is shared with the live apps. ~25 s for the Demo's 156,269
 * memberships. Until it is ready every request goes to the database, exactly
 * as before; nobody waits on the load.
 *
 * PROVEN BEFORE USED. A loaded market answers nothing until it has matched
 * the database on a set of real queries — the whole market, its biggest
 * city, brokerage, county and state, each range, an exclude, the units
 * order, page 2, the name search. One difference and that market stays on
 * the database (logged). The name / brokerage / city orders depend on the
 * database's collation; they are proven separately and only used if they
 * match.
 *
 * Kept 30 minutes, then reloaded (and proven again) in the background; at
 * most three markets at once. OS_MARKET_MEMORY=0 switches it all off.
 */

type Row = Record<string, unknown>;
type Db = ReturnType<typeof getCorofySupabase>;

const COLS = "id,full_name,title,brand,office_name,office_city,office_state,office_county,office_city_key,most_transacted_city,transacted_state,most_transacted_county,most_transacted_city_key,est_time_in_industry_months,preferred_email,enriched_email";
const PAGE = 1000;
const TTL_MS = 30 * 60_000;
const MAX_MARKETS = 3;

const s = (v: unknown) => (typeof v === "string" ? v : null);
const nOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function memoryOff(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.OS_MARKET_MEMORY?.trim() === "0";
}

/** At most `n` at once. */
async function pooled<T>(jobs: Array<() => Promise<T>>, n = 4): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }));
  return out;
}

/** The 16 slices of the uuid space, by first hex digit. */
const SLICES = "0123456789abcdef".split("").map((c, i, all) => ({
  from: `${c}0000000-0000-0000-0000-000000000000`,
  to: i + 1 < all.length ? `${all[i + 1]}0000000-0000-0000-0000-000000000000` : null,
}));

/**
 * Every row of a (agent_id, mls_id) table for these MLSs, one slice at a time,
 * keyset-paged on (agent_id, mls_id) — never OFFSET, which slows with depth.
 */
async function readSlices(db: Db, table: "agent_mls" | "agent_mls_stats", select: string, mlsIds: string[]): Promise<Row[]> {
  const slices = await pooled(SLICES.map((sl) => async () => {
    const rows: Row[] = [];
    let after: { agent: string; mls: string } | null = null;
    for (let guard = 0; guard < 10_000; guard++) {
      let q = db.from(table).select(select).in("mls_id", mlsIds).gte("agent_id", sl.from);
      if (sl.to) q = q.lt("agent_id", sl.to);
      if (after) q = q.or(`agent_id.gt.${after.agent},and(agent_id.eq.${after.agent},mls_id.gt.${after.mls})`);
      const { data, error } = await q.order("agent_id", { ascending: true }).order("mls_id", { ascending: true }).limit(PAGE);
      if (error) throw new Error(`${table}: ${error.message}`);
      const got = (data ?? []) as unknown as Row[];
      rows.push(...got);
      if (got.length < PAGE) break;
      const last = got[got.length - 1];
      after = { agent: String(last.agent_id), mls: String(last.mls_id) };
    }
    return rows;
  }));
  return slices.flat();
}

/** Whether every MLS of the market is scoped (fn_agent_where: stats for at least 90% of members). */
async function allScoped(db: Db, mlsIds: string[]): Promise<boolean> {
  const { data, error } = await db.from("mls").select("id, stats_agents, member_agents").in("id", mlsIds);
  if (error) throw new Error(`mls: ${error.message}`);
  const rows = (data ?? []) as Row[];
  return rows.length === mlsIds.length && rows.every((r) => (Number(r.stats_agents) || 0) >= 0.9 * Math.max(Number(r.member_agents) || 0, 1));
}

/** Sums in whole cents, as numeric would: no float drift at a filter's edge. */
function addCents(total: number | null, v: unknown): number | null {
  const n = nOrNull(v);
  if (n === null) return total;
  return (total ?? 0) + Math.round(n * 100);
}

/** The market's salespeople with their per-MLS numbers — or null when the market is not scoped (the database answers it). */
export async function loadMarket(mlsIds: readonly string[], db: Db = readOnly(getCorofySupabase()) as unknown as Db): Promise<MemMarket | null> {
  const ids = [...new Set(mlsIds)].sort();
  if (!ids.length || !(await allScoped(db, ids))) return null;
  const [members, stats] = await Promise.all([
    readSlices(db, "agent_mls", `agent_id,mls_id,agents(${COLS})`, ids),
    readSlices(db, "agent_mls_stats", "agent_id,mls_id,sales_volume,units", ids),
  ]);
  const volume = new Map<string, number | null>();
  const units = new Map<string, number | null>();
  for (const r of stats) {
    const id = String(r.agent_id);
    volume.set(id, addCents(volume.has(id) ? volume.get(id)! : null, r.sales_volume));
    units.set(id, addCents(units.has(id) ? units.get(id)! : null, r.units));
  }
  const agents = new Map<string, MemAgent>();
  for (const r of members) {
    const a = r.agents as Row | null;
    if (!a || agents.has(String(a.id))) continue;
    if (!titleTokens(s(a.title)).includes(MARKET_TITLE_TOKEN)) continue;
    const id = String(a.id);
    const v = volume.has(id) ? volume.get(id)! : null;
    const u = units.has(id) ? units.get(id)! : null;
    agents.set(id, {
      id,
      full_name: s(a.full_name), title: s(a.title), brand: s(a.brand), office_name: s(a.office_name),
      office_city: s(a.office_city), office_state: s(a.office_state), office_county: s(a.office_county), office_city_key: s(a.office_city_key),
      most_transacted_city: s(a.most_transacted_city), transacted_state: s(a.transacted_state),
      most_transacted_county: s(a.most_transacted_county), most_transacted_city_key: s(a.most_transacted_city_key),
      sales_volume: v === null ? null : v / 100,
      units: u === null ? null : u / 100,
      est_time_in_industry_months: nOrNull(a.est_time_in_industry_months),
      preferred_email: s(a.preferred_email), enriched_email: s(a.enriched_email),
    });
  }
  return { mlsIds: ids, agents: [...agents.values()], textSorts: false };
}

/* ------------------------------------------------------------ the proof --- */

export type DbSearch = (filters: Record<string, unknown>, limit: number, offset: number, sort: { by: string; dir: "asc" | "desc" }) =>
  Promise<{ rows: Array<Record<string, unknown>>; total: number; salesVolume: number }>;

function most<T>(items: Iterable<T | null>): T | null {
  const c = new Map<T, number>();
  for (const x of items) if (x !== null) c.set(x, (c.get(x) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}

/** The real queries a market must answer exactly as the database does. */
export function parityQueries(m: MemMarket, base: Record<string, unknown>): Array<{ label: string; filters: Record<string, unknown>; sort: { by: string; dir: "asc" | "desc" }; offset?: number; text?: boolean }> {
  const city = most(m.agents.map((a) => (a.office_city_key && a.office_state ? `${a.office_city_key}, ${a.office_state}` : null)));
  const county = most(m.agents.map((a) => (a.office_county && a.office_state ? `${a.office_county}, ${a.office_state}` : null)));
  const state = most(m.agents.map((a) => a.office_state));
  const brand = most(m.agents.map((a) => a.brand));
  const kinds = ["office", "transacted"];
  const loc = (values: unknown[], excludeValues: unknown[] = []) => ({ location: { field: "city", appliesTo: kinds, values, excludeValues, excludeField: "city" } });
  const org = (include: string[], exclude: string[]) => ({ officeSearch: { brand: { include, exclude }, office: { include: [], exclude: [] } } });
  const vol = { by: "sales_volume", dir: "desc" as const };
  const out: ReturnType<typeof parityQueries> = [
    { label: "the whole market", filters: { ...base }, sort: vol },
    { label: "page 2", filters: { ...base }, sort: vol, offset: 50 },
    { label: "units, fewest first", filters: { ...base }, sort: { by: "units", dir: "asc" } },
    { label: "volume ≥ $5M", filters: { ...base, salesVolume: { side: "all", buckets: [], min: "5000000", max: "" } }, sort: vol },
    { label: "units 4–20", filters: { ...base, closedUnits: { side: "all", buckets: [], min: "4", max: "20" } }, sort: vol },
    { label: "10+ years", filters: { ...base, estTimeInIndustry: { buckets: [], min: "10", max: "" } }, sort: vol },
    { label: "a name search", filters: { ...base, nameQuery: "smith" }, sort: vol },
  ];
  if (city) {
    out.push({ label: `city ${city}`, filters: { ...base, ...loc([{ f: "city", v: city }]) }, sort: vol });
    out.push({ label: `not city ${city}`, filters: { ...base, ...loc([], [{ f: "city", v: city }]) }, sort: vol });
    out.push({ label: `city ${city} + volume ≥ $2M + 4+ units`, filters: { ...base, ...loc([{ f: "city", v: city }]), salesVolume: { side: "all", buckets: [], min: "2000000", max: "" }, closedUnits: { side: "all", buckets: [], min: "4", max: "" } }, sort: vol });
  }
  if (county) out.push({ label: `county ${county}`, filters: { ...base, ...loc([{ f: "county", v: county }]) }, sort: vol });
  if (state) out.push({ label: `state ${state}`, filters: { ...base, ...loc([{ f: "state", v: state }]) }, sort: vol });
  if (brand) {
    out.push({ label: `brokerage ${brand}`, filters: { ...base, ...org([brand], []) }, sort: vol });
    out.push({ label: `not brokerage ${brand}`, filters: { ...base, ...org([], [brand]) }, sort: vol });
  }
  // The collation-dependent orders, proven on their own.
  out.push({ label: "by name", filters: { ...base }, sort: { by: "full_name", dir: "asc" }, text: true });
  out.push({ label: "by brokerage, Z–A", filters: { ...base }, sort: { by: "brand", dir: "desc" }, text: true });
  out.push({ label: "by office city", filters: { ...base }, sort: { by: "office_city", dir: "asc" }, text: true });
  out.push({ label: "name search, by name", filters: { ...base, nameQuery: "smith" }, sort: { by: "full_name", dir: "asc" }, text: true });
  return out;
}

export interface Proof {
  ok: boolean;
  textSorts: boolean;
  failures: string[];
  checked: number;
}

/** Each query both ways: the same total, the same volume to the cent, the same page in the same order. */
export async function proveMarket(m: MemMarket, base: Record<string, unknown>, dbSearch: DbSearch): Promise<Proof> {
  const failures: string[] = [];
  let textOk = true;
  let checked = 0;
  const probe = { ...m, textSorts: true, sorted: new Map(), orgs: new Map() } as MemMarket;
  // Three at a time: the agent database is shared with the live apps.
  await pooled(parityQueries(m, base).map((q) => async () => {
    const mem = searchMarket(probe, q.filters, q.sort, 50, q.offset ?? 0);
    if (!mem) { failures.push(`${q.label}: memory refused it`); return; }
    const db = await dbSearch(q.filters, 50, q.offset ?? 0, q.sort);
    checked++;
    const why = differs(mem, db);
    if (!why) return;
    if (q.text) textOk = false;
    failures.push(`${q.label}: ${why}`);
  }), 3);
  const hard = failures.filter((f) => !/^by |^name search, by name/.test(f));
  return { ok: hard.length === 0, textSorts: textOk, failures, checked };
}

function differs(mem: MemResult, db: { rows: Array<Record<string, unknown>>; total: number; salesVolume: number }): string | null {
  if (mem.total !== db.total) return `total ${mem.total} vs ${db.total}`;
  if (Math.round(mem.salesVolume * 100) !== Math.round(db.salesVolume * 100)) return `volume ${mem.salesVolume} vs ${db.salesVolume}`;
  const a = mem.rows.map((r) => r.id);
  const b = db.rows.map((r) => String(r.id));
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `row ${i + 1}: ${a[i] ?? "—"} vs ${b[i] ?? "—"}`;
  return null;
}

/* ----------------------------------------------------------- the holder --- */

type Slot =
  | { status: "loading"; since: number }
  | { status: "ready"; market: MemMarket; at: number; refreshing?: boolean }
  | { status: "unused"; reason: string; at: number };

const GLOBAL_KEY = "__osMarketMemory";
/* A plain object, shared by every bundle of the process (globalThis). Only memory — nothing here writes a database. */
function slots(): Record<string, Slot> {
  const g = globalThis as unknown as Record<string, Record<string, Slot>>;
  return (g[GLOBAL_KEY] ??= {});
}

const keyOf = (mlsIds: readonly string[]) => [...new Set(mlsIds)].sort().join(",");

/**
 * The proven market for these MLSs, if it is ready — and, if not (or stale),
 * starts loading it in the background. Never waits.
 */
export function marketFromMemory(mlsIds: readonly string[], base: Record<string, unknown>, dbSearch: DbSearch, now = Date.now()): MemMarket | null {
  if (memoryOff() || !mlsIds.length) return null;
  const key = keyOf(mlsIds);
  const all = slots();
  const slot = all[key];
  const start = () => {
    void (async () => {
      const t0 = Date.now();
      try {
        const m = await loadMarket(mlsIds);
        if (!m) {
          all[key] = { status: "unused", reason: "not scoped per MLS", at: Date.now() };
          return;
        }
        const proof = await proveMarket(m, base, dbSearch);
        if (!proof.ok) {
          all[key] = { status: "unused", reason: proof.failures.join(" | "), at: Date.now() };
          console.error(`[market-memory] ${key}: NOT used — differs from the database: ${proof.failures.join(" | ")}`);
          return;
        }
        all[key] = { status: "ready", market: { ...m, textSorts: proof.textSorts }, at: Date.now() };
        evict(all);
        console.log(`[market-memory] ${key}: ${m.agents.length} agents ready in ${Math.round((Date.now() - t0) / 1000)} s — ${proof.checked} checks matched${proof.textSorts ? "" : " (text orders stay on the database)"}`);
      } catch (e) {
        // Failed: forget it, so a later request tries again.
        const now2 = all[key];
        if (now2?.status === "loading") delete all[key];
        else if (now2?.status === "ready") now2.refreshing = false;
        console.error(`[market-memory] ${key}: load failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  };
  if (!slot) {
    all[key] = { status: "loading", since: now };
    start();
    return null;
  }
  if (slot.status === "loading") {
    // A load that never finished (a hung request): try again after 10 minutes.
    if (now - slot.since > 10 * 60_000) { all[key] = { status: "loading", since: now }; start(); }
    return null;
  }
  if (slot.status === "unused") {
    if (now - slot.at > TTL_MS) { all[key] = { status: "loading", since: now }; start(); }
    return null;
  }
  // Ready: served, and refreshed behind it once old.
  if (now - slot.at > TTL_MS && !slot.refreshing) {
    slot.refreshing = true;
    start();
  }
  return slot.market;
}

function evict(all: Record<string, Slot>) {
  const ready = Object.entries(all).filter(([, v]) => v.status === "ready") as Array<[string, Extract<Slot, { status: "ready" }>]>;
  ready.sort((a, b) => a[1].at - b[1].at);
  while (ready.length > MAX_MARKETS) delete all[ready.shift()![0]];
}

/** For the timing script and tests: what the holder has. */
export function memoryState(): Array<{ key: string; status: string; agents?: number; reason?: string }> {
  return Object.entries(slots()).map(([key, v]) => ({ key, status: v.status, ...(v.status === "ready" ? { agents: v.market.agents.length } : {}), ...(v.status === "unused" ? { reason: v.reason } : {}) }));
}
