import { mock, test } from "node:test";
import assert from "node:assert/strict";

import type { AgentRow } from "./demo-market.ts";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

let found: { ids: string[]; total: number } | { unavailable: string } = { ids: [], total: 0 };
let agents: AgentRow[] = [];
const asked: number[] = [];

let mod: typeof import("./export.ts");
if (canMock) {
  const realMarket = await import("./demo-market.ts");
  mock.module("./demo-market", { namedExports: { ...realMarket, agentsByIds: async (ids: readonly string[]) => agents.filter((a) => ids.includes(a.id)).reverse() } });
  const matchingIds = async (_ctx: unknown, _q: unknown, cap: number) => { asked.push(cap); return "unavailable" in found ? found : found.total > cap ? { ids: [], total: found.total } : found; };
  mock.module("./market", { namedExports: { matchingIds } });
  mod = await import("./export.ts");
}

const agent = (id: string, name: string, extra: Partial<AgentRow> = {}): AgentRow => ({
  id, full_name: name, preferred_email: `${id}@secret.test`, enriched_email: `${id}.work@secret.test`, preferred_phone: "555-0199", brand: "KW", office_name: "KW Center City", title: "Salesperson",
  office_city: "Philadelphia", office_county: null, home_city: null, home_county: null, most_transacted_city: "Philadelphia", most_transacted_county: null,
  office_state: "PA", home_state: null, transacted_state: "PA", sales_volume: 2_500_000, units: 9, est_time_in_industry_months: 131, ...extra,
});

test("who may export: Prospects anyone who may open the portal; Market our staff only", { skip }, () => {
  assert.equal(mod.mayExport("client", "prospects"), true);
  assert.equal(mod.mayExport("client", "market"), false);
  assert.equal(mod.mayExport("staff", "market"), true);
  assert.equal(mod.mayExport("staff", "prospects"), true);
});

test("the file: the columns on screen — never an email or a phone; quoted where needed; a formula never runs", { skip }, () => {
  const csv = mod.toCsv([
    agent("a1", "Jordan Ellis"),
    agent("a2", '=HYPERLINK("http://x","click")', { brand: null, office_name: "Smith, Jones & Co", sales_volume: null, units: null, est_time_in_industry_months: null, title: "+1 Agent", office_city: "@home" }),
  ]);
  assert.ok(csv.startsWith("﻿Name,Title,Brokerage,Office,Office city,Most transacted city,Sales volume,Units,Years in industry\r\n"));
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines[1], "Jordan Ellis,Salesperson,KW,KW Center City,Philadelphia,Philadelphia,2500000,9,10");
  assert.equal(lines[2], `"'=HYPERLINK(""http://x"",""click"")",'+1 Agent,"Smith, Jones & Co","Smith, Jones & Co",'@home,Philadelphia,,,`);
  assert.doesNotMatch(csv, /secret\.test|555-0199/, "no email, no phone");
  assert.equal(mod.exportFileName("Smith/Jones: Realty", "prospects", "2026-11-03"), "Smith Jones Realty Prospects 2026-11-03.csv");
  assert.equal(mod.exportFileName(null, "market", "2026-11-03"), "Portal Market 2026-11-03.csv");
});

test("the rows: every agent of the list, in the list's order; past 10,000 refused (narrow the filters); unavailable said", { skip }, async () => {
  agents = [agent("a1", "First"), agent("a2", "Second"), agent("a3", "Third")];
  found = { ids: ["a3", "a1", "a2"], total: 3 };
  const ctx = {} as never;
  const q = {} as never;
  const r = await mod.exportRows(ctx, q);
  assert.deepEqual("rows" in r ? r.rows.map((a) => a.id) : r, ["a3", "a1", "a2"], "the list's order, whatever order the database answered in");
  assert.equal(asked.at(-1), mod.EXPORT_MAX);
  found = { ids: [], total: 10_001 };
  assert.deepEqual(await mod.exportRows(ctx, q), { tooMany: 10_001 });
  found = { unavailable: "This portal is not linked to a client record, so its market is unknown." };
  assert.deepEqual(await mod.exportRows(ctx, q), found);
});
