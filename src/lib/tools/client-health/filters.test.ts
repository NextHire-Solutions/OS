/*
 * The Weekly view's filters.
 *
 * These pin the port against the live tool's switch statement. The failure
 * these guard against is quiet: a pill labelled "At Risk" that selects a
 * slightly different set than the tool's, which nobody notices because the
 * screen still looks right — it just answers a different question.
 *
 *   node --test src/lib/tools/client-health/filters.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyFilters, visibleTotal, type FilterState } from "./filters.ts";
import type { WeeklyRow } from "./summarize.ts";

const BASE: FilterState = { search: "", filter: "all", plan: "all", sort: null };

/** A row with only the fields the filters read. */
function row(
  name: string,
  o: Partial<{
    hidden: boolean; client_paused: boolean; plan: string;
    status: "risk" | "ok" | "done"; metTarget: boolean;
    campaigns: string[]; leftThisWeek: number; campaignsAvgPct: number;
  }> = {},
): WeeklyRow {
  return {
    client: {
      name,
      hidden: o.hidden ?? false,
      client_paused: o.client_paused ?? false,
      plan: o.plan ?? "minimum",
      campaigns: (o.campaigns ?? []).map((status) => ({ status })),
      bisonCampaigns: [],
    },
    derived: {
      status: o.status ?? "ok",
      metTarget: o.metTarget ?? false,
      leftThisWeek: o.leftThisWeek ?? 0,
      campaignsAvgPct: o.campaignsAvgPct ?? 0,
    },
  } as unknown as WeeklyRow;
}

const names = (rows: WeeklyRow[]) => rows.map((r) => r.client.name);

test("hidden and paused clients are excluded from every ordinary filter", () => {
  // The whole reason the headline reads 36 and not 48.
  const rows = [
    row("Active"),
    row("Churned", { hidden: true }),
    row("Paused", { client_paused: true }),
  ];
  for (const filter of ["all", "risk", "ok", "done", "active", "paused", "inactive"] as const) {
    const out = applyFilters(rows, { ...BASE, filter });
    assert.ok(!names(out).includes("Churned"), `${filter} admitted a hidden client`);
    assert.ok(!names(out).includes("Paused"), `${filter} admitted a paused client`);
  }
});

test("each excluded group has its own tab, and shows only itself there", () => {
  const rows = [row("Active"), row("Churned", { hidden: true }), row("Paused", { client_paused: true })];
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "hidden" })), ["Churned"]);
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "client-paused" })), ["Paused"]);
});

test("status pills select on derived status, not on the badge text", () => {
  const rows = [
    row("R", { status: "risk" }),
    row("O", { status: "ok" }),
    row("D", { status: "ok", metTarget: true }),
  ];
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "risk" })), ["R"]);
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "ok" })), ["O", "D"]);
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "done" })), ["D"]);
});

test("Paused means launched-but-not-running, not 'has no running campaign'", () => {
  // The distinction the tool draws, and the one most likely to be lost in a
  // port: a client that never launched is Not Active, not Paused.
  const rows = [
    row("Running", { campaigns: ["running"] }),
    row("Stopped", { campaigns: ["paused"] }),
    row("Finished", { campaigns: ["finished"] }),
    row("NeverLaunched", { campaigns: [] }),
    row("DraftOnly", { campaigns: ["draft"] }),
  ];
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "active" })), ["Running"]);
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "paused" })), ["Stopped", "Finished"]);
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "inactive" })), ["NeverLaunched", "DraftOnly"]);
});

test("a client with one running and one finished campaign counts as active", () => {
  const rows = [row("Mixed", { campaigns: ["finished", "running"] })];
  assert.equal(applyFilters(rows, { ...BASE, filter: "active" }).length, 1);
  assert.equal(applyFilters(rows, { ...BASE, filter: "paused" }).length, 0);
});

test("search is a case-insensitive substring, and ignores surrounding space", () => {
  const rows = [row("54 Realty"), row("Brooklyn Group"), row("The Keyes Company")];
  assert.deepEqual(names(applyFilters(rows, { ...BASE, search: "brook" })), ["Brooklyn Group"]);
  assert.deepEqual(names(applyFilters(rows, { ...BASE, search: "  KEYES  " })), ["The Keyes Company"]);
  assert.deepEqual(names(applyFilters(rows, { ...BASE, search: "realty" })), ["54 Realty"]);
});

test("an empty search is not a filter", () => {
  const rows = [row("A"), row("B")];
  assert.equal(applyFilters(rows, { ...BASE, search: "   " }).length, 2);
});

test("plan filter combines with the status pills rather than replacing them", () => {
  const rows = [
    row("A", { plan: "partner", status: "risk" }),
    row("B", { plan: "minimum", status: "risk" }),
    row("C", { plan: "partner", status: "ok" }),
  ];
  assert.deepEqual(names(applyFilters(rows, { ...BASE, filter: "risk", plan: "partner" })), ["A"]);
});

test("sorting orders by the column and reverses on ascending", () => {
  const rows = [
    row("low", { leftThisWeek: 1 }),
    row("high", { leftThisWeek: 9 }),
    row("mid", { leftThisWeek: 4 }),
  ];
  assert.deepEqual(
    names(applyFilters(rows, { ...BASE, sort: { col: "leftWeek", dir: "desc" } })),
    ["high", "mid", "low"],
  );
  assert.deepEqual(
    names(applyFilters(rows, { ...BASE, sort: { col: "leftWeek", dir: "asc" } })),
    ["low", "mid", "high"],
  );
});

test("sorting by campaign progress uses the derived average", () => {
  const rows = [row("a", { campaignsAvgPct: 10 }), row("b", { campaignsAvgPct: 80 })];
  assert.deepEqual(
    names(applyFilters(rows, { ...BASE, sort: { col: "campaigns", dir: "desc" } })),
    ["b", "a"],
  );
});

test("sorting does not mutate the caller's array", () => {
  // The array is memoised upstream; sorting it in place would corrupt a value
  // React believes is unchanged, and the bug would look like random reordering.
  const rows = [row("a", { leftThisWeek: 1 }), row("b", { leftThisWeek: 9 })];
  const before = names(rows);
  applyFilters(rows, { ...BASE, sort: { col: "leftWeek", dir: "desc" } });
  assert.deepEqual(names(rows), before);
});

test("no filter and no search returns the visible set unchanged", () => {
  const rows = [row("A"), row("B"), row("C", { hidden: true })];
  assert.equal(applyFilters(rows, BASE).length, 2);
  assert.equal(visibleTotal(rows), 2);
});
