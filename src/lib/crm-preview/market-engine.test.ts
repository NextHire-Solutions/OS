/*
 * The Market from memory: each rule of the Database app's search, reproduced —
 * and every request it must refuse (so the database answers it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cityEmbeddedState, cityMatchKey, searchMarket, titleTokens, type MemAgent, type MemMarket } from "./market-engine.ts";

const MLS = ["m-b", "m-a"];
const base = () => ({ mls: { include: [...MLS], exclude: [] }, title: { include: ["Salesperson"], exclude: [] } });

let n = 0;
function agent(p: Partial<MemAgent>): MemAgent {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    full_name: `Agent ${n}`, title: "Salesperson", brand: null, office_name: null,
    office_city: null, office_state: null, office_county: null, office_city_key: null,
    most_transacted_city: null, transacted_state: null, most_transacted_county: null, most_transacted_city_key: null,
    sales_volume: null, units: null, est_time_in_industry_months: null, preferred_email: null, enriched_email: null,
    ...p,
  };
}

const atl = agent({ full_name: "Ann Smith", brand: "Keller Williams", office_name: "KW Atlanta", office_city: "Atlanta", office_city_key: "atlanta", office_state: "GA", office_county: "Fulton", sales_volume: 9_000_000, units: 20, est_time_in_industry_months: 150 });
const atlEmbedded = agent({ full_name: "Bo Jones", brand: "RE/MAX", office_city: "Atlanta, GA", office_city_key: "atlanta", office_state: null, sales_volume: 3_000_000, units: 5 });
const atlTexas = agent({ full_name: "Cy Smith", brand: "Keller Williams", office_city: "Atlanta", office_city_key: "atlanta", office_state: "TX", sales_volume: 3_000_000, units: 6 });
const transacted = agent({ full_name: "Di Lee", brand: null, most_transacted_city: "Atlanta", most_transacted_city_key: "atlanta", transacted_state: "GA", office_city: "Marietta", office_city_key: "marietta", office_state: "GA", sales_volume: 1_000_000, units: 2 });
const nowhere = agent({ full_name: null, brand: "Compass", sales_volume: null, units: null });
const noStats = agent({ full_name: "Ed Ng", brand: "Compass", office_city: "Decatur", office_city_key: "decatur", office_state: "GA", office_county: "DeKalb", sales_volume: null, units: null, est_time_in_industry_months: 24 });

const market: MemMarket = { mlsIds: [...MLS].sort(), agents: [atl, atlEmbedded, atlTexas, transacted, nowhere, noStats] };
const run = (extra: Record<string, unknown>, sort: { by: string; dir: "asc" | "desc" } = { by: "sales_volume", dir: "desc" }, limit = 50, offset = 0) =>
  searchMarket(market, { ...base(), ...extra }, sort, limit, offset);
const names = (r: ReturnType<typeof run>) => r!.rows.map((a) => a.full_name);
const loc = (values: unknown[], extra: Record<string, unknown> = {}) => ({ location: { field: "city", appliesTo: ["office", "transacted"], values, excludeValues: [], excludeField: "city", ...extra } });

test("the database's city key, embedded state and title tokens", () => {
  assert.equal(cityMatchKey("  Atlanta  "), "atlanta");
  assert.equal(cityMatchKey("Atlanta, GA"), "atlanta");
  assert.equal(cityMatchKey("St. Louis (City)"), "st. louis");
  assert.equal(cityMatchKey("Boston 02110"), "boston");
  assert.equal(cityMatchKey("New   York."), "new york");
  assert.equal(cityMatchKey(""), null);
  assert.equal(cityEmbeddedState("Columbia, sc "), "SC");
  assert.equal(cityEmbeddedState("Columbia, ZZ"), null);
  assert.equal(cityEmbeddedState(null), null);
  assert.deepEqual(titleTokens("Salesperson, Team Leader"), ["salesperson", "teamleader"]);
  assert.deepEqual(titleTokens(null), []);
});

test("no filters: everyone, by the market's volume (nulls last), then id; the total and the volume", () => {
  const r = run({});
  assert.deepEqual(names(r), ["Ann Smith", "Bo Jones", "Cy Smith", "Di Lee", null, "Ed Ng"]);
  assert.equal(r!.total, 6);
  assert.equal(r!.salesVolume, 16_000_000);
});

test("a city with a state: the key and the state — a city's embedded state counts, another state does not", () => {
  assert.deepEqual(names(run(loc([{ f: "city", v: "Atlanta, GA" }]))), ["Ann Smith", "Bo Jones", "Di Lee"]);
  assert.deepEqual(names(run(loc([{ f: "city", v: "Atlanta, GA" }], { appliesTo: ["office"] }))), ["Ann Smith", "Bo Jones"]);
  assert.deepEqual(names(run(loc([{ f: "city", v: "Atlanta" }]))), ["Ann Smith", "Bo Jones", "Cy Smith", "Di Lee"], "no state: any state");
});

test("county and state levels, mixed in one filter (any of them)", () => {
  assert.deepEqual(names(run(loc([{ f: "county", v: "fulton, ga" }]))), ["Ann Smith"]);
  assert.deepEqual(names(run(loc([{ f: "county", v: "DeKalb, GA" }, { f: "state", v: "tx" }]))), ["Cy Smith", "Ed Ng"]);
});

test("excluding a place keeps everyone with no place at all", () => {
  const r = run({ location: { field: "city", appliesTo: ["office", "transacted"], values: [], excludeValues: [{ f: "city", v: "Atlanta, GA" }], excludeField: "city" } });
  assert.deepEqual(names(r), ["Cy Smith", null, "Ed Ng"]);
});

test("brokerage include is exact; exclude keeps a missing brokerage", () => {
  assert.deepEqual(names(run({ officeSearch: { brand: { include: ["Keller Williams"], exclude: [] }, office: { include: [], exclude: [] } } })), ["Ann Smith", "Cy Smith"]);
  assert.deepEqual(names(run({ officeSearch: { brand: { include: ["keller williams"], exclude: [] }, office: { include: [], exclude: [] } } })), [], "case matters, as in the database");
  assert.deepEqual(names(run({ officeSearch: { brand: { include: [], exclude: ["Keller Williams", "Compass"] }, office: { include: [], exclude: [] } } })), ["Bo Jones", "Di Lee"]);
});

test("ranges: inclusive, on the market's numbers; an agent with no numbers never passes; years are months × 12", () => {
  assert.deepEqual(names(run({ salesVolume: { side: "all", buckets: [], min: "3000000", max: "" } })), ["Ann Smith", "Bo Jones", "Cy Smith"]);
  assert.deepEqual(names(run({ closedUnits: { side: "all", buckets: [], min: "", max: "5" } })), ["Bo Jones", "Di Lee"]);
  assert.deepEqual(names(run({ estTimeInIndustry: { buckets: [], min: "2", max: "" } })), ["Ann Smith", "Ed Ng"]);
  assert.equal(run({ salesVolume: { side: "all", buckets: [], min: "", max: "" } })!.total, 6, "no bounds: no filter");
});

test("the two orders memory serves: the market's volume and units, nulls last either way, then id", () => {
  assert.deepEqual(names(run({}, { by: "units", dir: "desc" })), ["Ann Smith", "Cy Smith", "Bo Jones", "Di Lee", null, "Ed Ng"]);
  assert.deepEqual(names(run({}, { by: "sales_volume", dir: "asc" })), ["Di Lee", "Bo Jones", "Cy Smith", "Ann Smith", null, "Ed Ng"], "equal volumes by id; no volume last");
});

test("paging: the same order, sliced", () => {
  assert.deepEqual(names(run({}, { by: "sales_volume", dir: "desc" }, 2, 2)), ["Cy Smith", "Di Lee"]);
  assert.equal(run({}, { by: "sales_volume", dir: "desc" }, 2, 2)!.total, 6);
});

test("anything it does not reproduce exactly goes to the database", () => {
  assert.equal(searchMarket(market, { ...base(), orchClientIds: ["x"] }, { by: "sales_volume", dir: "desc" }, 50, 0), null, "an unknown filter");
  assert.equal(searchMarket(market, { mls: { include: ["m-a"], exclude: [] }, title: base().title }, { by: "sales_volume", dir: "desc" }, 50, 0), null, "another market");
  assert.equal(searchMarket(market, { mls: base().mls, title: { include: ["Team Leader"], exclude: [] } }, { by: "sales_volume", dir: "desc" }, 50, 0), null, "not the salespeople");
  assert.equal(run(loc([{ f: "city", v: "Atlanta" }], { appliesTo: ["home"] })), null, "home places are not held");
  assert.equal(run({ salesVolume: { side: "all", buckets: ["1M+"], min: "", max: "" } }), null, "buckets");
  assert.equal(run({ salesVolume: { side: "list", buckets: [], min: "1", max: "" } }), null, "list side");
  assert.equal(run({ nameQuery: "smith" }), null, "the search box — always the database's");
  assert.equal(run({ nameQuery: "%%%%%%%%%%%%%%%%%%%%x" }), null, "a wildcard search never reaches a regular expression");
  for (const by of ["full_name", "brand", "office_city", "most_transacted_city", "title", "license_number"]) assert.equal(run({}, { by, dir: "asc" }), null, `${by}: a text order is the database's collation`);
  assert.equal(run(loc([{ f: "city", v: "Atlanta\u00a0, GA" }])), null, "a no-break space: trims differ");
  assert.equal(run(loc([{ f: "city", v: "Atl\\anta" }])), null, "a backslash");
  assert.equal(run(loc([{ f: "city", v: "Ángel, GA" }])), null, "beyond plain ASCII");
});

test("a place filter that yields no condition is no filter — as the SQL adds none", () => {
  assert.equal(run(loc([{ f: "city", v: "(x)" }]))!.total, 6);
  assert.equal(run({ location: { field: "city", appliesTo: ["office", "transacted"], values: [], excludeValues: [{ f: "city", v: "(x)" }], excludeField: "city" } })!.total, 6);
});
