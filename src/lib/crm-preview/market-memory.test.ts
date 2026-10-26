/*
 * The market's name order (market-memory.ts): read in the database's own
 * order, ranked, carried across a refresh only when no name changed. Run with
 * node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { carryNames, loadNameOrder, nameQueries, parityQueries, rankNames } from "./market-memory.ts";
import type { MemAgent, MemMarket } from "./market-engine.ts";

const agent = (id: string, full_name: string | null): MemAgent => ({
  id, full_name, title: "Salesperson", brand: null, office_name: null, office_city: null, office_state: null, office_county: null, office_city_key: null,
  most_transacted_city: null, transacted_state: null, most_transacted_county: null, most_transacted_city_key: null,
  sales_volume: null, units: null, est_time_in_industry_months: null, preferred_email: null, enriched_email: null,
});
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

test("ranks follow the order read — equal names share one; no name ranks last", () => {
  const m: MemMarket = { mlsIds: ["m"], agents: [agent(id(1), "Bo"), agent(id(2), "(Al)"), agent(id(3), "Bo"), agent(id(4), null)] };
  // The database's order, not JavaScript's: here "(Al)" after "Bo" on purpose — the ranks must take it as given.
  const why = rankNames(m, [{ id: id(1), name: "Bo" }, { id: id(3), name: "Bo" }, { id: id(2), name: "(Al)" }, { id: id(9), name: "Zed, not a salesperson" }]);
  assert.equal(why, null);
  assert.deepEqual(m.agents.map((a) => a.nameRank), [0, 1, 0, Infinity]);
});

test("nothing is ranked when an agent is missing from the order, or was renamed since", () => {
  const m: MemMarket = { mlsIds: ["m"], agents: [agent(id(1), "Bo"), agent(id(2), "Al")] };
  assert.match(rankNames(m, [{ id: id(1), name: "Bo" }])!, /not in the database's name order/);
  assert.match(rankNames(m, [{ id: id(2), name: "Al" }, { id: id(1), name: "Bob" }])!, /renamed/);
  assert.deepEqual(m.agents.map((a) => a.nameRank), [undefined, undefined], "all or nothing");
});

test("a refresh keeps the proven order only when no name changed and no named agent is new", () => {
  const old: MemMarket = { mlsIds: ["m"], agents: [agent(id(1), "Bo"), agent(id(2), "Al"), agent(id(3), null)], namesReady: true };
  rankNames(old, [{ id: id(2), name: "Al" }, { id: id(1), name: "Bo" }]);
  const same: MemMarket = { mlsIds: ["m"], agents: [agent(id(2), "Al"), agent(id(1), "Bo"), agent(id(4), null)] };
  assert.equal(carryNames(old, same), true, "an agent gone, or a new one without a name, is fine");
  assert.deepEqual(same.agents.map((a) => a.nameRank), [0, 1, Infinity]);
  assert.equal(same.namesReady, undefined, "carried, not yet proven: the caller proves it");

  const renamed: MemMarket = { mlsIds: ["m"], agents: [agent(id(2), "Al"), agent(id(1), "Bob")] };
  assert.equal(carryNames(old, renamed), false);
  const added: MemMarket = { mlsIds: ["m"], agents: [agent(id(2), "Al"), agent(id(5), "Cy")] };
  assert.equal(carryNames(old, added), false);
  assert.deepEqual(added.agents.map((a) => a.nameRank), [undefined, undefined], "all or nothing");
  assert.equal(carryNames({ ...old, namesReady: false }, same), false, "only a proven order is carried");
});

/*
 * A stand-in for PostgREST's agents endpoint, holding names in "database
 * order" (byte order here). It applies the filters the loader sends — the
 * range and the keyset cursor, parsed back from its quoting — so a name with
 * quotes, backslashes, commas or brackets must survive the round trip.
 */
function fakeDb(rows: Array<{ id: string; name: string }>) {
  const sorted = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const calls: string[] = [];
  const unquote = (s: string) => s.replace(/\\(.)/g, "$1");
  const builder = () => {
    let lo: string | null = null;
    let hi: string | null = null;
    let after: { name: string; id: string } | null = null;
    let limit = Infinity;
    const b = {
      select: () => b, in: () => b, not: () => b, order: () => b,
      gte: (_c: string, v: string) => { lo = v; return b; },
      lt: (_c: string, v: string) => { hi = v; return b; },
      or: (expr: string) => {
        calls.push(expr);
        const m = /^full_name\.gt\.("(?:[^"\\]|\\.)*"),and\(full_name\.eq\.("(?:[^"\\]|\\.)*"),id\.gt\.([0-9a-f-]+)\)$/.exec(expr);
        assert.ok(m, `the cursor parses: ${expr}`);
        assert.equal(m[1], m[2]);
        after = { name: unquote(m[1].slice(1, -1)), id: m[3] };
        return b;
      },
      limit: (n: number) => {
        limit = n;
        const data = sorted
          .filter((r) => (lo === null || r.name >= lo) && (hi === null || r.name < hi))
          .filter((r) => !after || r.name > after.name || (r.name === after.name && r.id > after.id))
          .slice(0, limit)
          .map((r) => ({ id: r.id, full_name: r.name }));
        return Promise.resolve({ data, error: null });
      },
    };
    return b;
  };
  return { db: { from: () => builder() }, calls, sorted };
}

test("the name order is read range by range, page by page, and comes back whole and in order", async () => {
  const awkward = ['"Frank" Doe', "Back\\slash", "Comma, Jr.", "(Deborah) Lee", "Ann", "Ann", "Cy", "Gus", "Kim", "Ned", "Sam", "Zoe", "247 Property", "Ćelik"];
  const rows = awkward.map((name, i) => ({ id: id(i + 1), name }));
  const { db, calls, sorted } = fakeDb(rows);
  const got = await loadNameOrder(["m"], db as never);
  assert.deepEqual(got, sorted.map((r) => ({ id: r.id, name: r.name })), "the database's order, every name once");
  assert.equal(calls.length, 0, "a page short of 1000 is the last");
});

test("…and pages on with the cursor when a page is full", async () => {
  // 5,000 names: 3,334 before "C" with quotes, backslashes, commas and brackets; 1,666 the same name ("Dup"), so a page ends inside it.
  const names = Array.from({ length: 5000 }, (_, i) => (i % 3 === 0 ? `"Q" ${i}` : i % 3 === 1 ? `Back\\${i}, (x)` : `Dup`));
  const rows = names.map((name, i) => ({ id: id(i + 1), name }));
  const { db, calls, sorted } = fakeDb(rows);
  const got = await loadNameOrder(["m"], db as never);
  assert.deepEqual(got.map((r) => r.id), sorted.map((r) => r.id));
  assert.equal(new Set(got.map((r) => r.id)).size, 5000, "no agent twice");
  assert.equal(calls.length, 4, "3 pages on before C, 1 inside the Dups");
  assert.ok(calls.some((c) => c.startsWith('full_name.gt."Dup"')), "the cursor carries a tie on the name by the id");
});

test("the proofs include the search box and both name orders", () => {
  const agents = ["Ann Smith", "Bo Smith", "Cy Smith", "Di Jones"].map((n, i) => agent(id(i + 1), n));
  const m: MemMarket = { mlsIds: ["m"], agents };
  const base = { mls: { include: ["m"], exclude: [] } };
  const labels = parityQueries(m, base).map((q) => q.label);
  assert.ok(labels.includes('name contains "smith"'), labels.join(" | "));
  assert.ok(labels.includes('name contains "SMITH", by units'));
  const names = nameQueries(m, base);
  assert.deepEqual([...new Set(names.map((q) => q.sort.dir))].sort(), ["asc", "desc"]);
  assert.ok(names.every((q) => q.sort.by === "full_name"));
  assert.ok(names.some((q) => (q.offset ?? 0) >= 950), "a deep page");
  assert.ok(names.some((q) => "name" in q.filters), "with the search box");
});
