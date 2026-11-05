/*
 * The market's name order (market-memory.ts): read in the database's own
 * order, ranked, carried across a refresh only when no name changed. Run with
 * node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { carryNames, loadMarketZips, loadNameOrder, nameQueries, parityQueries, rankNames } from "./market-memory.ts";
import type { MemAgent, MemMarket } from "./market-engine.ts";

const agent = (id: string, full_name: string | null): MemAgent => ({
  id, full_name, title: "Salesperson", brand: null, office_name: null, office_city: null, office_state: null, office_county: null, office_city_key: null,
  most_transacted_city: null, transacted_state: null, most_transacted_county: null, most_transacted_city_key: null,
  office_zip: null, most_transacted_zip: null,
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

test("the proof covers zip codes: the biggest five-digit office zip, in and out, office only, and beside a city", () => {
  const z = (id: string, office_zip: string | null, city: string | null = null): MemAgent => ({ ...agent(id, `Agent ${id}`), office_zip, office_city: city, office_city_key: city?.toLowerCase() ?? null, office_state: city ? "TN" : null });
  const m: MemMarket = { mlsIds: ["m"], agents: [z("1", "37067", "Franklin"), z("2", "37067", "Franklin"), z("3", " 37064"), z("4", " 37064"), z("5", " 37064"), z("6", null)] };
  const qs = parityQueries(m, { mls: { include: ["m"], exclude: [] } });
  const zips = qs.filter((q) => /zip/.test(q.label)).map((q) => q.label);
  assert.deepEqual(zips, ["zip 37067", "not zip 37067", "zip 37067, office only, by units", "zip 37067 or city franklin, TN, not zip 37067"], "' 37064' is more common, but it isn't a zip anyone can pick");
  const none: MemMarket = { mlsIds: ["m"], agents: [z("1", null), z("2", "3706")] };
  assert.equal(parityQueries(none, {}).some((q) => /zip/.test(q.label)), false, "no zip, no zip query");
});

/* The market's zip codes (5 Nov): read the way the market is, each agent once, its titles as fn_title_tokens matches them. */
function zipDb(rows: Array<{ agent: string; mls: string; title: string | null; office: string | null; transacted: string | null }>) {
  const asked: Array<{ select: string; narrow: string | null; table: string | null }> = [];
  const db = {
    from: () => {
      let select = ""; let narrow: string | null = null; let table: string | null = null; let lo = ""; let hi: string | null = null;
      const b = {
        select: (x: string) => { select = x; return b; },
        in: () => b, order: () => b,
        gte: (_c: string, v: string) => { lo = v; return b; },
        lt: (_c: string, v: string) => { hi = v; return b; },
        or: (expr: string, opts?: { referencedTable?: string }) => { if (opts?.referencedTable) { narrow = expr; table = opts.referencedTable; } return b; },
        limit: () => {
          asked.push({ select, narrow, table });
          const data = rows.filter((r) => r.agent >= lo && (hi === null || r.agent < hi))
            .map((r) => ({ agent_id: r.agent, mls_id: r.mls, agents: { id: r.agent, title: r.title, office_zip: r.office, most_transacted_zip: r.transacted } }));
          return Promise.resolve({ data, error: null });
        },
      };
      return b;
    },
  };
  return { db, asked };
}

test("a market's zip codes: each agent once across MLSs, with the market's titles only", async () => {
  const { db, asked } = zipDb([
    { agent: "10000000-0000-4000-8000-000000000001", mls: "m1", title: "Salesperson", office: "37067", transacted: "37064" },
    { agent: "10000000-0000-4000-8000-000000000001", mls: "m2", title: "Salesperson", office: "37067", transacted: "37064" },
    { agent: "a0000000-0000-4000-8000-000000000002", mls: "m1", title: "Salesperson, Team Leader", office: "37215", transacted: null },
    { agent: "f0000000-0000-4000-8000-000000000003", mls: "m1", title: "Managing Broker", office: "37203", transacted: null },
    { agent: "f0000000-0000-4000-8000-000000000004", mls: "m2", title: null, office: "37203", transacted: null },
  ]);
  const sp = await loadMarketZips(["m2", "m1"], ["Salesperson"], db as never);
  assert.deepEqual(sp, [{ office: "37067", transacted: "37064" }, { office: "37215", transacted: null }]);
  assert.ok(asked.every((a) => a.narrow === null && /agents\(id,title,office_zip,most_transacted_zip\)/.test(a.select)), "a salesperson market reads every agent");
  assert.equal(asked.length, 16, "the 16 slices");
});

test("a market of other titles reads only agents whose title could be one, then the token match decides", async () => {
  const { db, asked } = zipDb([
    { agent: "a0000000-0000-4000-8000-000000000002", mls: "m1", title: "Salesperson, Team Leader", office: "37215", transacted: null },
    { agent: "b0000000-0000-4000-8000-000000000005", mls: "m1", title: "Team Leader Assistant", office: "37211", transacted: null },
    { agent: "f0000000-0000-4000-8000-000000000003", mls: "m1", title: "Managing  Broker", office: "37203", transacted: null },
  ]);
  const got = await loadMarketZips(["m1"], ["Team Leader", "Managing Broker"], db as never);
  assert.deepEqual(got, [{ office: "37215", transacted: null }, { office: "37203", transacted: null }], "an assistant isn't a team leader");
  assert.ok(asked.every((a) => a.narrow === "title.ilike.*team*leader*,title.ilike.*managing*broker*" && a.table === "agents"));
  assert.ok(asked.every((a) => a.select.includes("agents!inner(")), "inner, so the narrowing drops rows");
  assert.deepEqual(await loadMarketZips([], ["Salesperson"], db as never), []);
});

