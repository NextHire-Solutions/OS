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

import {
  applyFilters, presetRange, visibleTotal,
  BILLING_WINDOW_OPTIONS, FILTER_TABS, PLAN_OPTIONS, TZ_OPTIONS,
  type FilterState,
} from "./filters.ts";
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

/*
 * The three selects and the date range.
 *
 * Added with the rest of the tool's filter row. Each of these can silently
 * remove clients from a screen somebody is using to decide who to call, so
 * each one gets pinned to what the live tool does.
 */

/** A row with the fields the newer filters read. */
function client(
  name: string,
  o: Partial<{
    time_zone: string | null;
    start_date: string | null;
    billing_anchor_date: string | null;
    billing_interval: string;
    billing_interval_days: number | null;
  }> = {},
): WeeklyRow {
  const base = row(name);
  return {
    ...base,
    client: {
      ...base.client,
      time_zone: o.time_zone ?? null,
      start_date: o.start_date ?? null,
      billing_anchor_date: o.billing_anchor_date ?? null,
      billing_interval: o.billing_interval ?? "biweekly",
      billing_interval_days: o.billing_interval_days ?? null,
    },
  } as unknown as WeeklyRow;
}

const NOW = new Date("2026-09-11T12:00:00Z");

test("the time-zone filter matches the stored IANA string exactly", () => {
  const rows = [
    client("East", { time_zone: "America/New_York" }),
    client("West", { time_zone: "America/Los_Angeles" }),
    client("Unset"),
  ];

  assert.deepEqual(names(applyFilters(rows, { ...BASE, tz: "America/New_York" })), ["East"]);
  // A client with no time zone is not in every zone — it is in none.
  assert.deepEqual(names(applyFilters(rows, { ...BASE, tz: "America/Chicago" })), []);
  assert.equal(applyFilters(rows, { ...BASE, tz: "all" }).length, 3);
});

test("the billing window keeps only clients billing within N days", () => {
  // Anchored so the next fortnightly date is a known distance away.
  const rows = [
    client("Soon", { billing_anchor_date: "2026-09-14", billing_interval: "biweekly" }),
    client("Later", { billing_anchor_date: "2026-10-05", billing_interval: "biweekly" }),
    client("NoAnchor"),
  ];

  const within = (days: "7" | "14" | "30") =>
    names(applyFilters(rows, { ...BASE, billingWindow: days }, NOW));

  assert.deepEqual(within("7"), ["Soon"], "three days out");
  assert.ok(within("30").includes("Later"), "twenty-four days out");
  // No anchor and no start date means no billing date to be inside a window.
  assert.ok(!within("30").includes("NoAnchor"));
});

test("a client with no billing date is excluded rather than kept by default", () => {
  const rows = [client("NoAnchor")];
  assert.equal(applyFilters(rows, { ...BASE, billingWindow: "30" }, NOW).length, 0);
  assert.equal(applyFilters(rows, { ...BASE, billingWindow: "all" }, NOW).length, 1);
});

test("the date range filters on start date, inclusive at both ends", () => {
  const rows = [
    client("Jan", { start_date: "2026-01-15" }),
    client("Jun", { start_date: "2026-06-01" }),
    client("Sep", { start_date: "2026-09-01" }),
    client("Undated"),
  ];

  assert.deepEqual(
    names(applyFilters(rows, { ...BASE, dateFrom: "2026-06-01", dateTo: "2026-09-01" })),
    ["Jun", "Sep"],
    "both bounds are inclusive",
  );
  assert.deepEqual(names(applyFilters(rows, { ...BASE, dateFrom: "2026-06-02" })), ["Sep"]);
  assert.deepEqual(names(applyFilters(rows, { ...BASE, dateTo: "2026-01-31" })), ["Jan"]);
});

test("a client with no start date drops out of any date range", () => {
  // It has no answer to the question the filter asks, so keeping it would be
  // keeping it on a technicality.
  const rows = [client("Undated")];
  assert.equal(applyFilters(rows, { ...BASE, dateFrom: "2020-01-01" }).length, 0);
  assert.equal(applyFilters(rows, BASE).length, 1);
});

test("the filters compose — each narrows what the last one left", () => {
  const rows = [
    client("Match", { time_zone: "America/New_York", start_date: "2026-06-01" }),
    client("WrongZone", { time_zone: "America/Denver", start_date: "2026-06-01" }),
    client("WrongDate", { time_zone: "America/New_York", start_date: "2025-01-01" }),
  ];

  assert.deepEqual(
    names(applyFilters(rows, {
      ...BASE, tz: "America/New_York", dateFrom: "2026-01-01", dateTo: "2026-12-31",
    })),
    ["Match"],
  );
});

test("the presets are inclusive of today and land on whole days", () => {
  assert.deepEqual(presetRange("last7", NOW), { from: "2026-09-05", to: "2026-09-11" });
  assert.deepEqual(presetRange("last30", NOW), { from: "2026-08-13", to: "2026-09-11" });
  assert.deepEqual(presetRange("ytd", NOW), { from: "2026-01-01", to: "2026-09-11" });
});

test("the tool's nine filter tabs are all present, in its order", () => {
  assert.deepEqual(
    FILTER_TABS.map((f) => f.id),
    ["all", "risk", "ok", "done", "active", "paused", "inactive", "client-paused", "hidden"],
  );
  // The rename pass: these two labels are the distinction the tool draws.
  assert.equal(FILTER_TABS.find((f) => f.id === "paused")?.label, "Campaign Paused");
  assert.equal(FILTER_TABS.find((f) => f.id === "hidden")?.label, "Clients Churned");
});

test("every select offers an all-clearing option first", () => {
  // Without one there is no way back to the unfiltered list.
  assert.equal(PLAN_OPTIONS[0].id, "all");
  assert.equal(TZ_OPTIONS[0].id, "all");
  assert.equal(BILLING_WINDOW_OPTIONS[0].id, "all");
  assert.equal(TZ_OPTIONS.length, 8, "all, plus the seven zones the tool offers");
});
