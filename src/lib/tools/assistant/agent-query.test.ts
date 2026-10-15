import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFilters, describeQuery, parsePlace, pickPlace, stateCode } from "./agent-query.ts";

/*
 * "How many agents are in Dallas?" — the place, as the Database app's Agent
 * Search screen would be given it.
 */

test("states by code or name", () => {
  assert.equal(stateCode("TX"), "TX");
  assert.equal(stateCode("tx"), "TX");
  assert.equal(stateCode("Texas"), "TX");
  assert.equal(stateCode("new  york"), "NY");
  assert.equal(stateCode("District of Columbia"), "DC");
  assert.equal(stateCode("Dallas"), null);
  assert.equal(stateCode(""), null);
});

test("places as people write them", () => {
  const p = (t: string, l?: Parameters<typeof parsePlace>[1]) => parsePlace(t, l);
  assert.deepEqual(p("Dallas"), { level: "city", name: "Dallas", state: null });
  assert.deepEqual(p("Dallas, TX"), { level: "city", name: "Dallas", state: "TX" });
  assert.deepEqual(p("Dallas TX"), { level: "city", name: "Dallas", state: "TX" });
  assert.deepEqual(p("Dallas, Texas"), { level: "city", name: "Dallas", state: "TX" });
  assert.deepEqual(p("dallas texas"), { level: "city", name: "dallas", state: "TX" });
  assert.deepEqual(p("Dallas County"), { level: "county", name: "Dallas", state: null });
  assert.deepEqual(p("Dallas County, TX"), { level: "county", name: "Dallas", state: "TX" });
  assert.deepEqual(p("Orleans Parish"), { level: "county", name: "Orleans", state: null });
  assert.deepEqual(p("Texas"), { level: "state", name: "TX", state: "TX" });
  assert.deepEqual(p("TX"), { level: "state", name: "TX", state: "TX" });
  assert.deepEqual(p("75201"), { level: "zip", name: "75201", state: null });
  assert.deepEqual(p("Kansas City"), { level: "city", name: "Kansas City", state: null }, "City is not a state");
  assert.deepEqual(p("Kansas City Missouri"), { level: "city", name: "Kansas City", state: "MO" });
  assert.deepEqual(p("Salt Lake City, UT"), { level: "city", name: "Salt Lake City", state: "UT" });
  assert.deepEqual(p("New York New York"), { level: "city", name: "New York", state: "NY" });
  assert.deepEqual(p("Virginia Beach"), { level: "city", name: "Virginia Beach", state: null });
  assert.deepEqual(p("Agents in"), { level: "city", name: "Agents in", state: null }, "lower-case two letters are not a state");
  assert.deepEqual(p("New York", "city"), { level: "city", name: "New York", state: null }, "a level overrides the state reading");
  assert.deepEqual(p("Dallas", "county"), { level: "county", name: "Dallas", state: null });
  assert.equal(p("Dallas", "state"), null);
  assert.equal(p("   "), null);
});

// The Database app's own place list for "dallas" (fn_search_options, 16 Oct), trimmed.
const DALLAS = [
  { n: 15484, v: "Dallas, TX" }, { n: 972, v: "Dallas, GA" }, { n: 99, v: "Dallas, NC" },
  { n: 86, v: "Dallas, OR" }, { n: 80, v: "Lake Dallas, TX" }, { n: 2, v: "Dallastown, PA" },
];

test("Dallas means the biggest Dallas, and the answer can name the others; never Lake Dallas", () => {
  const r = pickPlace(DALLAS, parsePlace("Dallas")!);
  assert.equal(r.picked?.v, "Dallas, TX");
  assert.deepEqual(r.others.map((o) => o.v), ["Dallas, GA", "Dallas, NC", "Dallas, OR"]);
});

test("a state picks that one; a state with no such place picks nothing", () => {
  assert.equal(pickPlace(DALLAS, parsePlace("Dallas, GA")!).picked?.v, "Dallas, GA");
  const none = pickPlace(DALLAS, parsePlace("Dallas, FL")!);
  assert.equal(none.picked, null);
  assert.ok(none.others.some((o) => o.v === "Dallas, TX"), "offers the places of that name instead");
});

test("no exact name: nothing picked, the nearest offered", () => {
  const r = pickPlace(DALLAS, parsePlace("Dalas")!);
  assert.equal(r.picked, null);
  assert.equal(r.others[0].v, "Dallas, TX");
});

test("states and zips match exactly", () => {
  assert.equal(pickPlace([{ v: "TX", n: 138863 }], parsePlace("Texas")!).picked?.n, 138863);
  assert.equal(pickPlace([{ v: "75201", n: 900 }, { v: "75202", n: 5 }], parsePlace("75201")!).picked?.n, 900);
});

test("the filter is the Database screen's: a place matches office, home or most-transacted by default", () => {
  assert.deepEqual(buildFilters({ place: { level: "city", value: "Dallas, TX" } }), {
    location: { field: "city", appliesTo: ["office", "home", "transacted"], values: ["Dallas, TX"], excludeValues: [], excludeField: "city" },
  });
  const office = buildFilters({ place: { level: "county", value: "Dallas, TX" }, locatedBy: ["office"] }) as { location: { appliesTo: string[]; field: string } };
  assert.deepEqual(office.location.appliesTo, ["office"]);
  assert.equal(office.location.field, "county");
  assert.deepEqual(buildFilters({}), {}, "nothing asked, nothing sent — the whole database");
});

test("the other filters, only when asked, in the Database app's shapes", () => {
  const f = buildFilters({
    mlsIds: ["m1"], brands: ["Keller Williams"], minSalesVolume: 10_000_000, maxTransactions: 20.4,
    hasEmail: true, contacted: false, replied: true, clientIds: ["c1"],
  });
  assert.deepEqual(f, {
    mls: { include: ["m1"], exclude: [] },
    officeSearch: { brand: { include: ["Keller Williams"], exclude: [] }, office: { include: [], exclude: [] } },
    salesVolume: { side: "all", buckets: [], min: "10000000", max: "" },
    closedTransactions: { side: "all", buckets: [], min: "", max: "20" },
    contact: { email: "has", phone: "", enriched: "", inCampaign: "missing", replied: "has", bounced: "" },
    orchClientIds: ["c1"],
    orchClientMode: "include",
  });
});

test("nonsense numbers are dropped, not sent", () => {
  assert.deepEqual(buildFilters({ minSalesVolume: -5, maxSalesVolume: Number.NaN, minTransactions: Infinity }), {});
});

test("the filter in words, so the answer says what was counted", () => {
  assert.deepEqual(
    describeQuery({ place: { level: "city", value: "Dallas, TX" }, minSalesVolume: 10_000_000, contacted: false }),
    ["city Dallas, TX, matched on the agent's office, home or most-transacted location", "sales volume at least $10,000,000", "never in a campaign"],
  );
  assert.deepEqual(describeQuery({ place: { level: "city", value: "Dallas, TX" }, locatedBy: ["office"] }), ["city Dallas, TX, matched on the agent's office location"]);
});
