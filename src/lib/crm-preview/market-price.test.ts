/*
 * Average sales price on the new portal's Market (17 Nov, the user: "add a filter and column for average sales price"):
 * the query, the database filter it becomes, the memory's filter and order (only once proven), the exact weighted
 * average of a market scoped per MLS, the proof, and the lists filtered here. Run with
 * node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dbSortOf, FIRST_DIR, marketFilters, parseMarketQuery, PRICE_PRESETS } from "./market-model.ts";
import { searchMarket, type MemAgent, type MemMarket } from "./market-engine.ts";
import { loadMarket, PriceSums, priceQueries, proveMarketPrices, provePrices, requestPriceProof, type DbSearch } from "./market-memory.ts";
import { filterProspects, sortProspects, type AgentRow } from "./demo-market.ts";

const MLS = ["m-a", "m-b"];
const base = () => ({ mls: { include: [...MLS], exclude: [] }, title: { include: ["Salesperson"], exclude: [] } });

let n = 0;
function agent(p: Partial<MemAgent>): MemAgent {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    full_name: `Agent ${n}`, title: "Salesperson", brand: null, office_name: null,
    office_city: null, office_state: null, office_county: null, office_city_key: null,
    most_transacted_city: null, transacted_state: null, most_transacted_county: null, most_transacted_city_key: null,
    office_zip: null, most_transacted_zip: null,
    sales_volume: null, units: null, avg_sale_price: null, est_time_in_industry_months: null, preferred_email: null, enriched_email: null,
    ...p,
  };
}

const al = agent({ full_name: "Al", avg_sale_price: 500_000, sales_volume: 1_000_000, units: 2 });
const bea = agent({ full_name: "Bea", avg_sale_price: 300_000, sales_volume: 600_000, units: 2 });
const cal = agent({ full_name: "Cal", avg_sale_price: 500_000, sales_volume: 2_000_000, units: 4 });
const dee = agent({ full_name: "Dee", avg_sale_price: null, sales_volume: null, units: null });
const eve = agent({ full_name: "Eve", avg_sale_price: 0, sales_volume: 0, units: 0 });
const fay = agent({ full_name: "Fay", avg_sale_price: 1_250_000.5, sales_volume: 2_500_001, units: 2 });
const AGENTS = [cal, dee, al, fay, eve, bea];

const notReady = (): MemMarket => ({ mlsIds: [...MLS].sort(), agents: AGENTS });
const ready = (): MemMarket => ({ mlsIds: [...MLS].sort(), agents: AGENTS, priceReady: true });
const price = (min: string, max: string) => ({ avgSalePrice: { buckets: [], min, max } });
const names = (r: ReturnType<typeof searchMarket>) => r!.rows.map((a) => a.full_name);
const vol = { by: "sales_volume", dir: "desc" as const };

/* ------------------------------------------------------------------ the query --- */

test("the query: a min and max of whole dollars, bounded; the price sort largest first; the database's sort key", () => {
  const q = parseMarketQuery(new URLSearchParams("minPrice=500000&maxPrice=1000000&sort=price"));
  assert.deepEqual(q.price, { min: 500_000, max: 1_000_000 });
  assert.equal(q.sort, "price");
  assert.equal(q.dir, "desc");
  assert.equal(FIRST_DIR.price, "desc");
  assert.deepEqual(dbSortOf(q), { by: "avg_sale_price", dir: "desc" });
  assert.deepEqual(dbSortOf({ sort: "price", dir: "asc" }), { by: "avg_sale_price", dir: "asc" });
  // Out of bounds, negative or not a number: no bound at all.
  assert.deepEqual(parseMarketQuery(new URLSearchParams("minPrice=-5&maxPrice=2000000000")).price, { min: null, max: null });
  assert.deepEqual(parseMarketQuery(new URLSearchParams("minPrice=abc")).price, { min: null, max: null });
  assert.deepEqual(parseMarketQuery(new URLSearchParams("")).price, { min: null, max: null });
  assert.deepEqual([...PRICE_PRESETS], [250_000, 500_000, 750_000, 1_000_000]);
});

test("the database filter: avgSalePrice only when a bound is set, as text, no side", () => {
  const none = marketFilters(base(), parseMarketQuery(new URLSearchParams("")));
  assert.equal("avgSalePrice" in none, false);
  const min = marketFilters(base(), parseMarketQuery(new URLSearchParams("minPrice=500000")));
  assert.deepEqual(min.avgSalePrice, { buckets: [], min: "500000", max: "" });
  const both = marketFilters(base(), parseMarketQuery(new URLSearchParams("minPrice=250000&maxPrice=750000&minVolume=1000000")));
  assert.deepEqual(both.avgSalePrice, { buckets: [], min: "250000", max: "750000" });
  assert.deepEqual(both.salesVolume, { side: "all", buckets: [], min: "1000000", max: "" });
});

/* ----------------------------------------------------------------- the memory --- */

test("not yet proven: a price filter or the price order goes to the database (null); everything else is still answered", () => {
  assert.equal(searchMarket(notReady(), { ...base(), ...price("500000", "") }, vol, 50, 0), null);
  assert.equal(searchMarket(notReady(), base(), { by: "avg_sale_price", dir: "desc" }, 50, 0), null);
  // A price filter with no bound is no filter: answered.
  assert.equal(searchMarket(notReady(), { ...base(), ...price("", "") }, vol, 50, 0)!.total, 6);
  assert.equal(searchMarket(notReady(), { ...base(), salesVolume: { side: "all", buckets: [], min: "1000000", max: "" } }, vol, 50, 0)!.total, 3);
});

test("the filter: min and max inclusive, an agent with no price never passes a set bound, a $0 price is a price", () => {
  assert.deepEqual(names(searchMarket(ready(), { ...base(), ...price("500000", "") }, vol, 50, 0)), ["Fay", "Cal", "Al"]);
  assert.deepEqual(names(searchMarket(ready(), { ...base(), ...price("", "300000") }, vol, 50, 0)), ["Bea", "Eve"]);
  assert.deepEqual(names(searchMarket(ready(), { ...base(), ...price("500000", "500000") }, vol, 50, 0)), ["Cal", "Al"]);
  assert.deepEqual(names(searchMarket(ready(), { ...base(), ...price("1250000.5", "") }, vol, 50, 0)), ["Fay"]);
  assert.deepEqual(names(searchMarket(ready(), { ...base(), ...price("1250000.51", "") }, vol, 50, 0)), []);
  const r = searchMarket(ready(), { ...base(), ...price("400000", "") }, vol, 50, 0)!;
  assert.equal(r.total, 3);
  assert.equal(r.salesVolume, 5_500_001);
});

test("the order: the price, highest or lowest first, no price last either way, then the agent id", () => {
  assert.deepEqual(names(searchMarket(ready(), base(), { by: "avg_sale_price", dir: "desc" }, 50, 0)), ["Fay", "Al", "Cal", "Bea", "Eve", "Dee"]);
  assert.deepEqual(names(searchMarket(ready(), base(), { by: "avg_sale_price", dir: "asc" }, 50, 0)), ["Eve", "Bea", "Al", "Cal", "Fay", "Dee"]);
  // Al and Cal tie at $500K: the lower id first, both ways (Al was made first).
  assert.ok(al.id < cal.id);
  // Paging is a slice of the one order.
  assert.deepEqual(names(searchMarket(ready(), base(), { by: "avg_sale_price", dir: "desc" }, 2, 2)), ["Cal", "Bea"]);
});

/* ------------------------------------------------------- the weighted average --- */

test("scoped: the database's weighted average — sum(coalesce(price,0) * coalesce(units,0)) / sum(units), exactly", () => {
  const s = new PriceSums();
  s.add("x", 300_000, 2);
  s.add("x", 600_000, 1);
  assert.equal(s.priceOf("x", 3 * 10_000), 400_000);
  // A price missing on a row with units still counts its units (coalesce to 0): the average drops.
  s.add("y", null, 2);
  s.add("y", 600_000, 2);
  assert.equal(s.priceOf("y", 4 * 10_000), 300_000);
  // No units on record, or units adding to nothing: no average.
  s.add("z", 900_000, null);
  assert.equal(s.priceOf("z", null), null);
  assert.equal(s.priceOf("z", 0), null);
  // One division of the exact sums: the double nearest the true quotient, as for 500,000 / 3.
  s.add("w", 100_000, 1);
  s.add("w", 200_000, 2);
  assert.equal(s.priceOf("w", 3 * 10_000), 500_000 / 3);
  // Cents are exact; split deals (ten-thousandths of a unit) too.
  s.add("v", 333_333.33, 3);
  assert.equal(s.priceOf("v", 3 * 10_000), 333_333.33);
  s.add("u", 400_000, 0.5);
  s.add("u", 100_000, 1.5);
  assert.equal(s.priceOf("u", 2 * 10_000), 175_000);
  assert.equal(s.exact, true);
});

test("a price finer than a cent, or a sum too large to add exactly: not exact (filter and order to the database), the price still shown", () => {
  const fine = new PriceSums();
  fine.add("x", 100.005, 1);
  fine.add("y", 450_000, 2);
  assert.equal(fine.exact, false);
  assert.match(String(fine.why), /finer than a cent/);
  // Review, 17 Nov: the column must not go blank — each agent's price from the same sums, to far under a cent.
  assert.ok(Math.abs(fine.priceOf("x", 10_000)! - 100.005) < 1e-9);
  assert.equal(fine.priceOf("y", 2 * 10_000), 450_000);
  assert.equal(fine.priceOf("y", 0), null);
  const huge = new PriceSums();
  huge.add("x", 9e12, 10_000);
  assert.equal(huge.exact, false);
  assert.equal(huge.priceOf("x", 10_000 * 10_000), 9e12);
});

/* ------------------------------------------------------------------ the load --- */

type Rows = Record<string, Array<Record<string, unknown>>>;
/** Just enough of PostgREST for loadMarket: the MLS rows, and the two tables read slice by slice (agent_id bounds, mls_id in). */
function fakeDb(tables: Rows) {
  return {
    from(table: string) {
      const where: Array<(r: Record<string, unknown>) => boolean> = [];
      const q = {
        select: () => q,
        in: (col: string, vals: unknown[]) => { where.push((r) => vals.includes(r[col])); return q; },
        gte: (col: string, v: string) => { where.push((r) => String(r[col]) >= v); return q; },
        lt: (col: string, v: string) => { where.push((r) => String(r[col]) < v); return q; },
        or: () => q,
        order: () => q,
        limit: () => q,
        then: (ok: (v: { data: unknown[]; error: null }) => unknown) => ok({ data: (tables[table] ?? []).filter((r) => where.every((w) => w(r))), error: null }),
      };
      return q;
    },
  } as never;
}
const A1 = "10000000-0000-4000-8000-000000000001";
const A2 = "20000000-0000-4000-8000-000000000002";
const B1 = "30000000-0000-4000-8000-000000000003";
const person = (id: string, extra: Record<string, unknown> = {}) => ({ id, full_name: `P ${id.slice(0, 2)}`, title: "Salesperson", sales_volume: 9, units: 9, avg_sale_price: 1, ...extra });
const member = (agent_id: string, mls_id: string, extra: Record<string, unknown> = {}) => ({ agent_id, mls_id, agents: person(agent_id, extra) });
const scopedMls = [{ id: "m-a", stats_agents: 10, member_agents: 10, bulk_refreshed_at: "x" }, { id: "m-b", stats_agents: 10, member_agents: 10, bulk_refreshed_at: "x" }];

test("loading a market scoped per MLS: each agent's price is the weighted average over the market's MLSs", async () => {
  const db = fakeDb({
    mls: scopedMls,
    agent_mls: [member(A1, "m-a"), member(A1, "m-b"), member(A2, "m-a"), member(B1, "m-a", { title: "Managing Broker" })],
    agent_mls_stats: [
      { agent_id: A1, mls_id: "m-a", sales_volume: 600_000, units: 2, avg_sale_price: 300_000 },
      { agent_id: A1, mls_id: "m-b", sales_volume: 600_000, units: 1, avg_sale_price: 600_000 },
      { agent_id: A2, mls_id: "m-a", sales_volume: 0, units: 0, avg_sale_price: 0 },
    ],
  });
  const loaded = await loadMarket(MLS, db);
  assert.ok("market" in loaded);
  const by = new Map(loaded.market.agents.map((a) => [a.id, a]));
  assert.equal(loaded.market.scoped, true);
  assert.equal(by.get(A1)!.avg_sale_price, 400_000);
  assert.equal(by.get(A1)!.sales_volume, 1_200_000);
  // No units in the market: no average (the database's NULL), not $0.
  assert.equal(by.get(A2)!.avg_sale_price, null);
  assert.equal(by.has(B1), false, "salespeople only");
  assert.equal(loaded.market.priceUnused, undefined);
});

test("loading a market not scoped per MLS: the agent's own price, as stored", async () => {
  const db = fakeDb({
    mls: [{ id: "m-a", stats_agents: 1, member_agents: 10, bulk_refreshed_at: "x" }, { id: "m-b", stats_agents: 10, member_agents: 10, bulk_refreshed_at: "x" }],
    agent_mls: [member(A1, "m-a", { avg_sale_price: 351_566.66666666667, units: 6, sales_volume: 2_109_400 }), member(A2, "m-b", { avg_sale_price: null })],
  });
  const loaded = await loadMarket(MLS, db);
  assert.ok("market" in loaded);
  const by = new Map(loaded.market.agents.map((a) => [a.id, a]));
  assert.equal(loaded.market.scoped, false);
  assert.equal(by.get(A1)!.avg_sale_price, 351_566.66666666667);
  assert.equal(by.get(A2)!.avg_sale_price, null);
});

test("a price that can't be summed exactly leaves only the prices to the database: the market itself still loads", async () => {
  const db = fakeDb({
    mls: scopedMls,
    agent_mls: [member(A1, "m-a")],
    agent_mls_stats: [{ agent_id: A1, mls_id: "m-a", sales_volume: 500_000, units: 1, avg_sale_price: 500_000.125 }],
  });
  const loaded = await loadMarket(MLS, db);
  assert.ok("market" in loaded, "the market is still answered from memory");
  assert.match(String(loaded.market.priceUnused), /finer than a cent/);
  assert.equal(loaded.market.agents[0].sales_volume, 500_000);
  assert.equal(loaded.market.agents[0].avg_sale_price, 500_000.125, "the column still shows the price");
});

test("review, 17 Nov: in such a market the default page is answered here WITH every agent's price; a price filter or order is not", async () => {
  const db = fakeDb({
    mls: scopedMls,
    agent_mls: [member(A1, "m-a"), member(A2, "m-a")],
    agent_mls_stats: [
      { agent_id: A1, mls_id: "m-a", sales_volume: 900_000, units: 2, avg_sale_price: 450_000 },
      { agent_id: A2, mls_id: "m-a", sales_volume: 500_000.13, units: 1, avg_sale_price: 500_000.125 },
    ],
  });
  const loaded = await loadMarket(MLS, db);
  assert.ok("market" in loaded);
  const m = loaded.market;
  const page = searchMarket(m, base(), vol, 50, 0)!;
  assert.deepEqual(page.rows.map((a) => a.avg_sale_price), [450_000, 500_000.125]);
  assert.equal(searchMarket(m, { ...base(), ...price("400000", "") }, vol, 50, 0), null);
  assert.equal(searchMarket(m, base(), { by: "avg_sale_price", dir: "desc" }, 50, 0), null);
});

/* ----------------------------------------------------------------- the proof --- */

test("the proof: both orders, deep pages, ranges, a bound some agents sit on exactly, and with other filters", () => {
  const withCity = { mlsIds: MLS, agents: [...AGENTS, agent({ office_city_key: "atlanta", office_state: "GA", avg_sale_price: 500_000 })] };
  const qs = priceQueries(withCity, base());
  const labels = qs.map((q) => q.label);
  for (const want of ["price, highest first", "price, lowest first", "price, highest first, the last page a search may reach", "price ≥ $500K", "price up to $300K, by units", "price $300K–$600K, highest first"]) assert.ok(labels.includes(want), want);
  assert.ok(labels.some((l) => /^price from exactly \$500000/.test(l)), "an exact lower bound on a whole-dollar price agents have");
  assert.ok(labels.some((l) => /^price up to exactly \$500000/.test(l)));
  assert.ok(labels.some((l) => /^city atlanta, GA \+ price/.test(l)));
  assert.ok(qs.some((q) => q.offset === 950 && q.sort.by === "avg_sale_price"));
  assert.ok(qs.some((q) => q.sort.by === "avg_sale_price" && q.sort.dir === "asc"));
  for (const q of qs) assert.deepEqual((q.filters as { mls: unknown }).mls, base().mls);
});

/** A database that answers exactly as the memory would — optionally with one thing changed. */
function mirror(m: MemMarket, change?: (rows: Array<Record<string, unknown>>) => void): DbSearch {
  return async (filters, limit, offset, sort) => {
    const r = searchMarket({ mlsIds: m.mlsIds, agents: m.agents, priceReady: true }, filters, sort, limit, offset)!;
    const rows = r.rows.map((a) => ({ ...a }) as Record<string, unknown>);
    change?.(rows);
    return { rows, total: r.total, salesVolume: r.salesVolume };
  };
}

test("proven when every page matches the database — order, totals and each row's price to the cent", async () => {
  const m = notReady();
  const ok = await provePrices(m, base(), mirror(m));
  assert.equal(ok.ok, true, ok.failures.join(" | "));
  assert.equal(ok.checked, priceQueries(m, base()).length);
  assert.equal(m.priceReady, undefined, "proving never marks the market itself");
});

test("not proven when one row's price differs by a cent, or the order differs", async () => {
  const m = notReady();
  const price = await provePrices(m, base(), mirror(m, (rows) => { if (rows[0]) rows[0].avg_sale_price = Number(rows[0].avg_sale_price ?? 0) + 0.01; }));
  assert.equal(price.ok, false);
  assert.ok(price.failures.some((f) => /price of/.test(f)), price.failures.join(" | "));
  const order = await provePrices(m, base(), mirror(m, (rows) => rows.reverse()));
  assert.equal(order.ok, false);
  // The database's price as text (numeric over JSON) is still the same price.
  const text = await provePrices(m, base(), mirror(m, (rows) => { for (const r of rows) if (r.avg_sale_price !== null) r.avg_sale_price = String(r.avg_sale_price); }));
  assert.equal(text.ok, true, text.failures.join(" | "));
});

/* ---------------------------------------------- the lists filtered here --- */

const row = (id: string, avg: number | null): AgentRow => ({
  id, full_name: `Agent ${id}`, preferred_email: null, enriched_email: null, preferred_phone: null, brand: null, office_name: null, title: "Salesperson",
  office_city: null, office_county: null, home_city: null, home_county: null, most_transacted_city: null, most_transacted_county: null, office_zip: null, most_transacted_zip: null,
  office_state: null, home_state: null, transacted_state: null, sales_volume: 1, units: 1, avg_sale_price: avg, est_time_in_industry_months: null,
});

test("Prospects kept here (the Demo's, a client's moved ones): the same filter and order on the agent's own price", () => {
  const rows = [row("a", 500_000), row("b", 300_000), row("c", null), row("d", 0), row("e", 750_000)];
  const ids = (q: string) => filterProspects(rows, parseMarketQuery(new URLSearchParams(q))).map((a) => a.id);
  assert.deepEqual(ids("minPrice=500000"), ["a", "e"]);
  assert.deepEqual(ids("maxPrice=300000"), ["b", "d"]);
  assert.deepEqual(ids("minPrice=300000&maxPrice=500000"), ["a", "b"]);
  assert.deepEqual(ids(""), ["a", "b", "c", "d", "e"]);
  const sorted = (q: string) => sortProspects(rows, parseMarketQuery(new URLSearchParams(q))).map((a) => a.id);
  assert.deepEqual(sorted("sort=price"), ["e", "a", "b", "d", "c"]);
  assert.deepEqual(sorted("sort=price&dir=asc"), ["d", "b", "a", "e", "c"]);
});

/* ------------------------------------------------- trying the proof again --- */

/** A held copy in the process's market store (as marketFromMemory keeps it), for the holder's own rules. */
function hold(m: MemMarket) {
  const g = globalThis as unknown as Record<string, { slots: Record<string, unknown>; running: Record<number, number>; next: number }>;
  g.__osMarketMemory = { slots: { [[...MLS].sort().join(",")]: { status: "ready", market: m, at: 0, lastUsed: 0, verifiedAt: 0, refreshing: null, refreshAfter: 0 } }, running: {}, next: 1 };
  return g.__osMarketMemory;
}
const KEY = [...MLS].sort().join(",");

test("a proof the database couldn't finish is tried again after five minutes, when a price is asked for — and then answered here", async () => {
  const m = notReady();
  const st = hold(m);
  await proveMarketPrices(KEY, m, base(), async () => { throw new Error("canceling statement due to statement timeout"); }, () => 1_000);
  assert.equal(m.priceReady, undefined);
  assert.equal(m.priceTried, true);
  assert.equal(m.priceRetryAfter, 1_000 + 5 * 60_000);
  assert.equal(requestPriceProof(MLS, base(), mirror(m), 1_000 + 5 * 60_000 - 1), null, "not before the wait is over");
  st.running[99] = 1_000 + 5 * 60_000;
  assert.equal(requestPriceProof(MLS, base(), mirror(m), 1_000 + 5 * 60_000), null, "not while another load runs");
  delete st.running[99];
  const run = requestPriceProof(MLS, base(), mirror(m), 1_000 + 5 * 60_000);
  assert.ok(run);
  assert.equal(Object.keys(st.running).length, 1, "it counts as the one load running");
  assert.equal(requestPriceProof(MLS, base(), mirror(m), 1_000 + 5 * 60_000), null, "never two at once");
  await run;
  assert.equal(m.priceReady, true);
  assert.equal(m.priceRetryAfter, undefined);
  assert.equal(Object.keys(st.running).length, 0);
  assert.equal(m.priceProving, false);
});

test("a proof that DIFFERS is not tried again (the copy's next refresh proves afresh); a market that can't be exact never", async () => {
  const m = notReady();
  hold(m);
  await proveMarketPrices(KEY, m, base(), mirror(m, (rows) => rows.reverse()), () => 1_000);
  assert.equal(m.priceReady, undefined);
  assert.equal(m.priceRetryAfter, undefined);
  assert.equal(requestPriceProof(MLS, base(), mirror(m), 10_000_000), null);
  const unusable: MemMarket = { ...notReady(), priceUnused: "a price of 1.005 is finer than a cent", priceTried: true, priceRetryAfter: 0 };
  hold(unusable);
  assert.equal(requestPriceProof(MLS, base(), mirror(unusable), 10_000_000), null);
  // A copy no longer held is never marked.
  const gone = notReady();
  hold(notReady());
  await proveMarketPrices(KEY, gone, base(), mirror(gone), () => 1_000);
  assert.equal(gone.priceReady, undefined);
});
