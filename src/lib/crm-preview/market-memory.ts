import "server-only";

import { readOnly } from "@/lib/tools/assistant/read-only";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

import { MARKET_TITLE_TOKEN, searchMarket, titleTokens, type MemAgent, type MemMarket, type MemResult } from "./market-engine";

/*
 * The market held in memory (market-engine.ts says why and how it answers).
 *
 * LOADING. In the background, the first time a portal's Market is asked for
 * (one load at a time for the whole server):
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
 * the database (logged).
 *
 * THE NAME ORDER (27 Oct) is the database's collation, not JavaScript's, so it
 * is read from the database once the market is ready — in the background,
 * the first time someone sorts by name (or kept warm) — and proven on its own
 * before a name sort is answered here. Brokerage / city / title orders stay
 * on the database.
 *
 * Kept 30 minutes, then reloaded (and proven again) in the background, and
 * dropped at once if the agent database refreshes the market's MLSs; at most
 * three markets, never served past an hour. OS_MARKET_MEMORY=0 switches it
 * all off.
 */

type Row = Record<string, unknown>;
type Db = ReturnType<typeof getCorofySupabase>;

// The agent's own sales_volume / units are the market's numbers when it is NOT scoped per MLS (fn_agent_where's rule).
const COLS = "id,full_name,title,brand,office_name,office_city,office_state,office_county,office_city_key,most_transacted_city,transacted_state,most_transacted_county,most_transacted_city_key,est_time_in_industry_months,sales_volume,units,preferred_email,enriched_email";
/** Above this many salespeople a market stays on the database (memory budget: ~0.5 KB an agent). */
const MAX_AGENTS = 250_000;
const PAGE = 1000;
const TTL_MS = 30 * 60_000;
const MAX_MARKETS = 4;

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

/** The market's MLS rows as loaded: whether each is scoped, and when its data was last refreshed. */
type MlsStamp = Array<{ id: string; stats_agents: number; member_agents: number; refreshed: string | null }>;

async function readStamp(db: Db, mlsIds: string[]): Promise<MlsStamp> {
  const { data, error } = await db.from("mls").select("id, stats_agents, member_agents, bulk_refreshed_at").in("id", mlsIds);
  if (error) throw new Error(`mls: ${error.message}`);
  return ((data ?? []) as Row[])
    .map((r) => ({ id: String(r.id), stats_agents: Number(r.stats_agents) || 0, member_agents: Number(r.member_agents) || 0, refreshed: s(r.bulk_refreshed_at) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** fn_agent_where's rule: every MLS with stats for at least 90% of its members. */
const allScoped = (stamp: MlsStamp, mlsIds: string[]) =>
  stamp.length === mlsIds.length && stamp.every((r) => r.stats_agents >= 0.9 * Math.max(r.member_agents, 1));

const sameStamp = (a: MlsStamp, b: MlsStamp) => JSON.stringify(a) === JSON.stringify(b);

/*
 * Sums as whole numbers — numeric's exact sums, not floating point drift at a
 * filter's edge: volume in cents, units in ten-thousandths (split deals). A
 * value finer than that cannot be summed exactly here, and the market stays
 * on the database.
 */
const SCALE = { volume: 100, units: 10_000 } as const;
class Inexact extends Error {}
function addScaled(total: number | null, v: unknown, scale: number): number | null {
  const n = nOrNull(v);
  if (n === null) return total;
  const scaled = n * scale;
  // Relative to the size: a large exact cent amount carries floating-point noise of its own.
  if (Math.abs(scaled - Math.round(scaled)) > Math.max(1e-6, Math.abs(scaled) * 1e-12)) throw new Inexact(`a value of ${n} is finer than 1/${scale}`);
  return (total ?? 0) + Math.round(scaled);
}

export type Loaded = { market: MemMarket; stamp: MlsStamp } | { unused: string };

/**
 * The market's salespeople with the numbers the database uses for it — or
 * why it stays on the database. SCOPED (every MLS has stats for 90% of its
 * members): each agent's sums over these MLSs (agent_mls_stats). NOT scoped:
 * the agent's own sales_volume and units (agents), exactly as fn_agent_where
 * and fn_filter_search then read them. Either way the proof decides.
 */
export async function loadMarket(mlsIds: readonly string[], db: Db = readOnly(getCorofySupabase()) as unknown as Db): Promise<Loaded> {
  const ids = [...new Set(mlsIds)].sort();
  if (!ids.length) return { unused: "no MLS" };
  const stamp = await readStamp(db, ids);
  if (stamp.length !== ids.length) return { unused: "an MLS is missing" };
  const scoped = allScoped(stamp, ids);
  const [members, stats] = await Promise.all([
    readSlices(db, "agent_mls", `agent_id,mls_id,agents(${COLS})`, ids),
    scoped ? readSlices(db, "agent_mls_stats", "agent_id,mls_id,sales_volume,units", ids) : Promise.resolve([] as Row[]),
  ]);
  const volume = new Map<string, number | null>();
  const units = new Map<string, number | null>();
  try {
    if (scoped) {
      for (const r of stats) {
        const id = String(r.agent_id);
        volume.set(id, addScaled(volume.has(id) ? volume.get(id)! : null, r.sales_volume, SCALE.volume));
        units.set(id, addScaled(units.has(id) ? units.get(id)! : null, r.units, SCALE.units));
      }
    } else {
      for (const r of members) {
        const a = r.agents as Row | null;
        if (!a || volume.has(String(a.id))) continue;
        volume.set(String(a.id), addScaled(null, a.sales_volume, SCALE.volume));
        units.set(String(a.id), addScaled(null, a.units, SCALE.units));
      }
    }
  } catch (e) {
    if (e instanceof Inexact) return { unused: e.message };
    throw e;
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
      sales_volume: v === null ? null : v / SCALE.volume,
      units: u === null ? null : u / SCALE.units,
      est_time_in_industry_months: nOrNull(a.est_time_in_industry_months),
      preferred_email: s(a.preferred_email), enriched_email: s(a.enriched_email),
    });
  }
  if (agents.size > MAX_AGENTS) return { unused: `${agents.size} salespeople is above the memory budget` };
  return { market: { mlsIds: ids, agents: [...agents.values()], scoped }, stamp };
}

/* ------------------------------------------------------- the name order --- */

/*
 * The market's named agents IN THE DATABASE'S OWN ORDER — order by
 * full_name, id, exactly what fn_filter_search sorts by (0119: "full_name
 * <dir> nulls last, a.id") — so no two names are ever compared here. Its
 * collation is not JavaScript's: punctuation, then digits, then letters
 * (“Christi”, "Frank", (Deborah), 247 Property, A Allen…).
 *
 * Six ranges of names read side by side, three at a time, each keyset-paged
 * on (full_name, id). Each range is the database's own comparison, so the
 * ranges in turn are its whole order. ~117 pages for the Demo's 116,123
 * names. All agents in the MLSs, not only salespeople: a superset keeps the
 * same order.
 */
const NAME_RANGES = ["", "C", "G", "K", "N", "S"];

/** A value inside PostgREST's or=(…): double-quoted, with \ and " escaped. */
const quoted = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export async function loadNameOrder(mlsIds: readonly string[], db: Db = readOnly(getCorofySupabase()) as unknown as Db): Promise<Array<{ id: string; name: string }>> {
  const ids = [...new Set(mlsIds)].sort();
  const ranges = await pooled(NAME_RANGES.map((lo, i) => async () => {
    const hi = NAME_RANGES[i + 1] ?? null;
    const rows: Array<{ id: string; name: string }> = [];
    let after: { name: string; id: string } | null = null;
    for (let guard = 0; guard < 10_000; guard++) {
      let q = db.from("agents").select("id,full_name,agent_mls!inner(mls_id)").in("agent_mls.mls_id", ids).not("full_name", "is", null);
      if (lo) q = q.gte("full_name", lo);
      if (hi) q = q.lt("full_name", hi);
      if (after) q = q.or(`full_name.gt.${quoted(after.name)},and(full_name.eq.${quoted(after.name)},id.gt.${after.id})`);
      const { data, error } = await q.order("full_name", { ascending: true }).order("id", { ascending: true }).limit(PAGE);
      if (error) throw new Error(`agents by name: ${error.message}`);
      const got = (data ?? []) as unknown as Row[];
      for (const r of got) rows.push({ id: String(r.id), name: String(r.full_name) });
      if (got.length < PAGE) break;
      after = rows[rows.length - 1];
    }
    return rows;
  }), 3);
  return ranges.flat();
}

/**
 * Each agent's place in that order (equal names share one; the id breaks the
 * tie, as there) — or why not: an agent of the market missing from it, or
 * named differently than when the market was read. Nothing is set unless
 * every named agent has its place.
 */
export function rankNames(m: MemMarket, ordered: ReadonlyArray<{ id: string; name: string }>): string | null {
  const place = new Map<string, { name: string; rank: number }>();
  let rank = -1;
  let prev: string | null = null;
  for (const o of ordered) {
    if (o.name !== prev) { rank++; prev = o.name; }
    place.set(o.id, { name: o.name, rank });
  }
  for (const a of m.agents) {
    if (a.full_name === null) continue;
    const p = place.get(a.id);
    if (!p) return `${a.id} is not in the database's name order`;
    if (p.name !== a.full_name) return `${a.id} was renamed since the market was read`;
  }
  for (const a of m.agents) a.nameRank = a.full_name === null ? Infinity : place.get(a.id)!.rank;
  return null;
}

/**
 * A refreshed copy keeps the proven order of the copy it replaces when no
 * name changed and no named agent is new — relative places hold, and the
 * names are not read again every half hour. Otherwise false, and nothing set.
 */
export function carryNames(from: MemMarket, to: MemMarket): boolean {
  if (!from.namesReady) return false;
  const old = new Map(from.agents.map((a) => [a.id, a]));
  for (const a of to.agents) {
    if (a.full_name === null) continue;
    const o = old.get(a.id);
    if (!o || o.full_name !== a.full_name || o.nameRank === undefined || o.nameRank === Infinity) return false;
  }
  for (const a of to.agents) a.nameRank = a.full_name === null ? Infinity : old.get(a.id)!.nameRank;
  return true;
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

/** The real queries a market must answer exactly as the database does — every order memory serves, first and last pages. */
export function parityQueries(m: MemMarket, base: Record<string, unknown>): Array<{ label: string; filters: Record<string, unknown>; sort: { by: string; dir: "asc" | "desc" }; offset?: number }> {
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
    { label: "the last page a search may reach", filters: { ...base }, sort: vol, offset: 950 },
    { label: "volume, smallest first", filters: { ...base }, sort: { by: "sales_volume", dir: "asc" } },
    { label: "units, most first, page 3", filters: { ...base }, sort: { by: "units", dir: "desc" }, offset: 100 },
    { label: "units, fewest first", filters: { ...base }, sort: { by: "units", dir: "asc" } },
    { label: "volume ≥ $5M", filters: { ...base, salesVolume: { side: "all", buckets: [], min: "5000000", max: "" } }, sort: vol },
    { label: "units 4–20", filters: { ...base, closedUnits: { side: "all", buckets: [], min: "4", max: "20" } }, sort: vol },
    { label: "10+ years", filters: { ...base, estTimeInIndustry: { buckets: [], min: "10", max: "" } }, sort: vol },
  ];
  if (city) {
    out.push({ label: `city ${city}`, filters: { ...base, ...loc([{ f: "city", v: city }]) }, sort: vol });
    out.push({ label: `not city ${city}`, filters: { ...base, ...loc([], [{ f: "city", v: city }]) }, sort: vol });
    out.push({ label: `city ${city} + volume ≥ $2M + 4+ units, by units`, filters: { ...base, ...loc([{ f: "city", v: city }]), salesVolume: { side: "all", buckets: [], min: "2000000", max: "" }, closedUnits: { side: "all", buckets: [], min: "4", max: "" } }, sort: { by: "units", dir: "desc" } });
  }
  if (county) out.push({ label: `county ${county}`, filters: { ...base, ...loc([{ f: "county", v: county }]) }, sort: vol });
  if (state) out.push({ label: `state ${state}`, filters: { ...base, ...loc([{ f: "state", v: state }]) }, sort: vol });
  if (brand) {
    out.push({ label: `brokerage ${brand}`, filters: { ...base, ...org([brand], []) }, sort: vol });
    out.push({ label: `not brokerage ${brand}`, filters: { ...base, ...org([], [brand]) }, sort: vol });
  }
  // The search box: a common surname, in capitals too (any case), part of one, and with a city.
  const word = commonSurname(m);
  if (word) {
    const name = (...include: string[]) => ({ name: { include, exclude: [] } });
    out.push({ label: `name contains "${word}"`, filters: { ...base, ...name(word) }, sort: vol });
    out.push({ label: `name contains "${word.toUpperCase()}", by units`, filters: { ...base, ...name(word.toUpperCase()) }, sort: { by: "units", dir: "desc" } });
    out.push({ label: `name contains "${word.slice(0, 3)}" or "${word.slice(-3)}", page 2`, filters: { ...base, ...name(word.slice(0, 3), word.slice(-3)) }, sort: vol, offset: 50 });
    if (city) out.push({ label: `name contains "${word}" + city ${city}`, filters: { ...base, ...name(word), ...loc([{ f: "city", v: city }]) }, sort: vol });
  }
  return out;
}

/** The market's most common last name (letters only, 4+), lower-cased — a search box text that matches many. */
function commonSurname(m: MemMarket): string | null {
  return most(m.agents.map((a) => {
    const last = a.full_name?.trim().split(/\s+/).pop() ?? "";
    return /^[A-Za-z]{4,}$/.test(last) ? last.toLowerCase() : null;
  }));
}

/** The name order's own proof: both ways, deep pages, under filters, with the search box. */
export function nameQueries(m: MemMarket, base: Record<string, unknown>): ReturnType<typeof parityQueries> {
  const city = most(m.agents.map((a) => (a.office_city_key && a.office_state ? `${a.office_city_key}, ${a.office_state}` : null)));
  const word = commonSurname(m);
  const asc = { by: "full_name", dir: "asc" as const };
  const desc = { by: "full_name", dir: "desc" as const };
  const out: ReturnType<typeof parityQueries> = [
    { label: "names A→Z", filters: { ...base }, sort: asc },
    { label: "names Z→A", filters: { ...base }, sort: desc },
    { label: "names A→Z, page 2", filters: { ...base }, sort: asc, offset: 50 },
    { label: "names A→Z, the last page a search may reach", filters: { ...base }, sort: asc, offset: 950 },
    { label: "names Z→A, page 11", filters: { ...base }, sort: desc, offset: 500 },
    { label: "names A→Z, volume ≥ $2M", filters: { ...base, salesVolume: { side: "all", buckets: [], min: "2000000", max: "" } }, sort: asc },
  ];
  if (city) out.push({ label: `names Z→A, city ${city}`, filters: { ...base, location: { field: "city", appliesTo: ["office", "transacted"], values: [{ f: "city", v: city }], excludeValues: [], excludeField: "city" } }, sort: desc });
  if (word) out.push({ label: `names A→Z, name contains "${word}"`, filters: { ...base, name: { include: [word], exclude: [] } }, sort: asc });
  return out;
}

export interface Proof {
  ok: boolean;
  failures: string[];
  checked: number;
}

/** Each query both ways: the same total, the same volume to the cent, the same page in the same order. */
export async function proveMarket(m: MemMarket, base: Record<string, unknown>, dbSearch: DbSearch): Promise<Proof> {
  // Its own sort cache: the copy that is served never inherits anything from the proof.
  return prove({ mlsIds: m.mlsIds, agents: m.agents, sorted: new Map() }, parityQueries(m, base), dbSearch);
}

/** The name order, once its ranks are set: answered as if ready, against the database. */
export async function proveNames(m: MemMarket, base: Record<string, unknown>, dbSearch: DbSearch): Promise<Proof> {
  return prove({ mlsIds: m.mlsIds, agents: m.agents, sorted: new Map(), namesReady: true }, nameQueries(m, base), dbSearch);
}

async function prove(probe: MemMarket, queries: ReturnType<typeof parityQueries>, dbSearch: DbSearch): Promise<Proof> {
  const failures: string[] = [];
  let checked = 0;
  // Three at a time: the agent database is shared with the live apps.
  await pooled(queries.map((q) => async () => {
    const mem = searchMarket(probe, q.filters, q.sort, 50, q.offset ?? 0);
    if (!mem) { failures.push(`${q.label}: memory refused it`); return; }
    const db = await dbSearch(q.filters, 50, q.offset ?? 0, q.sort);
    checked++;
    const why = differs(mem, db);
    if (why) failures.push(`${q.label}: ${why}`);
  }), 3);
  return { ok: failures.length === 0, failures, checked };
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

/*
 * Bounded (two audits, 26 Oct):
 *   - ONE load at a time across all markets (a refresh counts; a load hung
 *     past HUNG_MS stops counting): the raw rows of a load are the biggest
 *     thing in memory, and the agent database is shared. Others wait their
 *     turn — on the database, as before.
 *   - a load writes only into the slot that started it (a token).
 *   - at most MAX_MARKETS held; the one used longest ago goes first.
 *   - a load or proof that fails, or a market the agent database refreshed,
 *     waits COOL_DOWN before loading again.
 *   - a market is never served older than MAX_AGE, refresh or not.
 *   - FRESH: a copy is served only if its MLS rows were checked against the
 *     agent database within the last minute (one small read, awaited when
 *     due); if an MLS refreshed or stopped being scoped, it is dropped.
 */
const COOL_DOWN_MS = 10 * 60_000;
const MAX_AGE_MS = 2 * TTL_MS;
const PROBE_MS = 60_000;
const HUNG_MS = 10 * 60_000;

type Slot =
  | { status: "loading"; since: number; token: number }
  | { status: "ready"; market: MemMarket; stamp: MlsStamp; at: number; lastUsed: number; verifiedAt: number; verifying?: boolean; refreshing: number | null; refreshAfter: number; namesLoading?: number | null; namesRetryAfter?: number }
  | { status: "unused"; reason: string; retryAfter: number };

const GLOBAL_KEY = "__osMarketMemory";
/* Plain objects, shared by every bundle of the process (globalThis). Only memory — nothing here writes a database. */
function store(): { slots: Record<string, Slot>; running: Record<number, number>; next: number } {
  const g = globalThis as unknown as Record<string, { slots: Record<string, Slot>; running: Record<number, number>; next: number }>;
  return (g[GLOBAL_KEY] ??= { slots: {}, running: {}, next: 1 });
}
const slots = () => store().slots;

const keyOf = (mlsIds: readonly string[]) => [...new Set(mlsIds)].sort().join(",");

/*
 * Loads running, counted on their own — not read off the slots, which an
 * eviction or a probe can replace while the load still runs. A load that
 * has run past HUNG_MS stops counting (it can no longer block the others),
 * though it still may not write over a newer slot (its token).
 */
function inFlight(now: number): number {
  return Object.values(store().running).filter((since) => now - since < HUNG_MS).length;
}

/**
 * One load. Its result is written only if the slot is still the one that
 * started it (its token) — an older, slower load never overwrites a newer
 * copy, and a market evicted or dropped meanwhile is not brought back.
 */
function startLoad(key: string, mlsIds: readonly string[], base: Record<string, unknown>, dbSearch: DbSearch, owner: (slot: Slot | undefined) => boolean, token: number) {
  const st = store();
  const all = st.slots;
  st.running[token] = Date.now();
  void (async () => {
    const t0 = Date.now();
    try {
      const loaded = await loadMarket(mlsIds);
      if (!owner(all[key])) return;
      if ("unused" in loaded) {
        all[key] = { status: "unused", reason: loaded.unused, retryAfter: Date.now() + TTL_MS };
        return;
      }
      const proof = await proveMarket(loaded.market, base, dbSearch);
      if (!owner(all[key])) return;
      if (!proof.ok) {
        all[key] = { status: "unused", reason: proof.failures.join(" | "), retryAfter: Date.now() + TTL_MS };
        console.error(`[market-memory] ${key}: NOT used — differs from the database: ${proof.failures.join(" | ")}`);
        return;
      }
      // A refresh keeps the name order it replaces when no name changed — proven again on this copy.
      const prev = all[key];
      if (prev?.status === "ready" && carryNames(prev.market, loaded.market)) {
        const names = await proveNames(loaded.market, base, dbSearch);
        if (!owner(all[key])) return;
        if (names.ok) loaded.market.namesReady = true;
        else console.error(`[market-memory] ${key}: the carried name order differs — read again when asked: ${names.failures.join(" | ")}`);
      }
      const now = Date.now();
      all[key] = { status: "ready", market: loaded.market, stamp: loaded.stamp, at: now, lastUsed: now, verifiedAt: now, refreshing: null, refreshAfter: 0 };
      evict(all);
      console.log(`[market-memory] ${key}: ${loaded.market.agents.length} agents ready in ${Math.round((now - t0) / 1000)} s — ${proof.checked} checks matched`);
    } catch (e) {
      const cur = all[key];
      if (owner(cur)) {
        if (cur?.status === "ready") { cur.refreshing = null; cur.refreshAfter = Date.now() + COOL_DOWN_MS; }
        else all[key] = { status: "unused", reason: "load failed", retryAfter: Date.now() + COOL_DOWN_MS };
      }
      console.error(`[market-memory] ${key}: load failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      delete st.running[token];
    }
  })();
}

/**
 * Whether the agent database moved under a held market (an MLS refreshed,
 * or its scoping flipped). One small read. Moved: the copy is dropped, and
 * reloaded only after COOL_DOWN — the database is mid-ingest then, and a
 * reload per ingest chunk would be the heaviest work at its busiest time.
 */
async function verify(key: string, slot: Extract<Slot, { status: "ready" }>, now: number): Promise<boolean> {
  try {
    const db = readOnly(getCorofySupabase()) as unknown as Db;
    const stamp = await readStamp(db, slot.market.mlsIds);
    if (sameStamp(stamp, slot.stamp) && allScoped(stamp, slot.market.mlsIds) === slot.market.scoped) {
      slot.verifiedAt = now;
      return true;
    }
    const all = slots();
    if (all[key] === slot) all[key] = { status: "unused", reason: "the agent database refreshed this market", retryAfter: now + COOL_DOWN_MS };
    console.log(`[market-memory] ${key}: the agent database moved — back to the database, reloaded in ${COOL_DOWN_MS / 60_000} min`);
    return false;
  } catch {
    // Unchecked is not served: this request goes to the database; the next one checks again.
    return false;
  }
}

/**
 * The proven market for these MLSs, if it is ready — checked against the
 * agent database within the last minute (a one-row read, awaited when due:
 * milliseconds) — and, if not ready, starts loading it in the background
 * when it may. Never waits on a load.
 */
export async function marketFromMemory(mlsIds: readonly string[], base: Record<string, unknown>, dbSearch: DbSearch, now = Date.now()): Promise<MemMarket | null> {
  if (memoryOff() || !mlsIds.length) return null;
  const key = keyOf(mlsIds);
  const st = store();
  const all = st.slots;
  const slot = all[key];
  const canStart = inFlight(now) === 0;
  const begin = () => {
    const token = st.next++;
    all[key] = { status: "loading", since: now, token };
    startLoad(key, mlsIds, base, dbSearch, (cur) => cur?.status === "loading" && cur.token === token, token);
  };

  if (!slot) {
    if (canStart) begin();
    return null;
  }
  if (slot.status === "loading") {
    if (now - slot.since > HUNG_MS && canStart) begin();
    return null;
  }
  if (slot.status === "unused") {
    if (now >= slot.retryAfter && canStart) begin();
    return null;
  }
  // Ready: refreshed in the background once old (the old copy serving meanwhile), never served past MAX_AGE.
  const refreshHung = slot.refreshing !== null && now - slot.refreshing > HUNG_MS;
  if (now - slot.at > TTL_MS && (slot.refreshing === null || refreshHung) && canStart && now >= slot.refreshAfter) {
    const token = st.next++;
    slot.refreshing = now;
    startLoad(key, mlsIds, base, dbSearch, (cur) => cur === slot && slot.refreshing === now, token);
  }
  if (now - slot.at > MAX_AGE_MS) return null;
  slot.lastUsed = now;
  const age = now - slot.verifiedAt;
  if (age > PROBE_MS) {
    // Not checked within the minute: checked now, before anything is served (one small read).
    if (!(await verify(key, slot, now))) return null;
  } else if (age > PROBE_MS * 0.75 && !slot.verifying) {
    // In use and nearly due: checked in the background, so no request has to wait for it.
    slot.verifying = true;
    void verify(key, slot, now).finally(() => { slot.verifying = false; });
  }
  return slot.market;
}

/**
 * Starts reading a held market's name order (loadNameOrder) in the
 * background, when it may — it counts as the one load running, so it waits
 * for any other and nothing else starts meanwhile. Nobody waits on it: until
 * it is read and proven, a name sort is the database's. Written only into the
 * copy that asked, and only if that copy is still the one held.
 */
export function requestNameOrder(mlsIds: readonly string[], base: Record<string, unknown>, dbSearch: DbSearch, now = Date.now()): void {
  if (memoryOff() || !mlsIds.length) return;
  const key = keyOf(mlsIds);
  const st = store();
  const slot = st.slots[key];
  if (slot?.status !== "ready" || slot.market.namesReady) return;
  if (typeof slot.namesLoading === "number" && now - slot.namesLoading < HUNG_MS) return;
  if (now < (slot.namesRetryAfter ?? 0) || inFlight(now) > 0) return;
  const token = st.next++;
  st.running[token] = now;
  slot.namesLoading = now;
  const mine = () => st.slots[key] === slot && slot.namesLoading === now;
  void (async () => {
    const t0 = Date.now();
    try {
      const ordered = await loadNameOrder(slot.market.mlsIds);
      if (!mine()) return;
      const why = rankNames(slot.market, ordered);
      if (why) {
        slot.namesRetryAfter = Date.now() + COOL_DOWN_MS;
        console.error(`[market-memory] ${key}: name order NOT used — ${why}`);
        return;
      }
      const proof = await proveNames(slot.market, base, dbSearch);
      if (!mine()) return;
      if (!proof.ok) {
        slot.namesRetryAfter = Date.now() + TTL_MS;
        console.error(`[market-memory] ${key}: name order NOT used — differs from the database: ${proof.failures.join(" | ")}`);
        return;
      }
      // No name order was ever cached while not ready (the comparator refuses it), so nothing stale is left to clear.
      slot.market.namesReady = true;
      console.log(`[market-memory] ${key}: name order of ${ordered.length} names ready in ${Math.round((Date.now() - t0) / 1000)} s — ${proof.checked} checks matched`);
    } catch (e) {
      if (mine()) slot.namesRetryAfter = Date.now() + COOL_DOWN_MS;
      console.error(`[market-memory] ${key}: name order failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      delete st.running[token];
      if (slot.namesLoading === now) slot.namesLoading = null;
    }
  })();
}

/** At most MAX_MARKETS held — the one used longest ago goes first. */
function evict(all: Record<string, Slot>) {
  const ready = Object.entries(all).filter(([, v]) => v.status === "ready") as Array<[string, Extract<Slot, { status: "ready" }>]>;
  ready.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (ready.length > MAX_MARKETS) delete all[ready.shift()![0]];
}

/** For the timing script and tests: what the holder has. */
export function memoryState(): Array<{ key: string; status: string; agents?: number; names?: boolean; reason?: string }> {
  return Object.entries(slots()).map(([key, v]) => ({ key, status: v.status, ...(v.status === "ready" ? { agents: v.market.agents.length, names: !!v.market.namesReady } : {}), ...(v.status === "unused" ? { reason: v.reason } : {}) }));
}
