/*
 * The Weekly view's column sorts.
 *
 * One rule carries almost all the risk here, and it is the reason these are
 * tested at all: a MISSING value must sink in both directions.
 *
 *   a client with no time zone is not "the earliest time zone";
 *   a client with no monthly target is not "furthest behind";
 *   a client with no introductions is not "the longest since the last one";
 *   a client with no funnel is not "the worst conversion rate".
 *
 * Get it wrong and the clients nobody has set up yet float to the top of the
 * list somebody scans to decide who needs attention — which is worse than no
 * sort at all, because the list looks authoritative.
 *
 *   node --test src/lib/tools/client-health/sorting.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { sortWeekly, type SortCol } from "./sorting.ts";
import type { WeeklyRow } from "./summarize.ts";

const NOW = new Date("2026-09-09T12:00:00Z");

function row(name: string, client: Record<string, unknown> = {}, derived: Record<string, unknown> = {}): WeeklyRow {
  return {
    client: {
      id: name, name,
      time_zone: null, monthly_target: 0, intros_this_month: 0,
      billing_anchor_date: null, start_date: null,
      billing_interval: "biweekly", billing_interval_days: null,
      campaigns: [], bisonCampaigns: [], metricsByWeek: {},
      ...client,
    },
    derived: {
      leftThisWeek: 0, emails: 0, intros: 0, campaignsAvgPct: 0,
      convPct: null, daysSince: null,
      ...derived,
    },
  } as unknown as WeeklyRow;
}

const names = (rows: WeeklyRow[]) => rows.map((r) => r.client.name);
const both = (rows: WeeklyRow[], col: SortCol) =>
  (["desc", "asc"] as const).map((dir) => names(sortWeekly(rows, { col, dir }, NOW)));

test("a missing value sinks to the bottom in BOTH directions", () => {
  // The rule the whole file exists for, checked on every column that has one.
  const cases: [SortCol, WeeklyRow[]][] = [
    ["tz", [row("None"), row("Has", { time_zone: "America/New_York" })]],
    ["monthly", [row("None"), row("Has", { monthly_target: 5, intros_this_month: 2 })]],
    ["lastIntro", [row("None"), row("Has", {}, { daysSince: 3 })]],
    ["conv", [row("None"), row("Has", {}, { convPct: 40 })]],
    ["billing", [row("None"), row("Has", { billing_anchor_date: "2026-09-01" })]],
    ["convRate", [
      row("None"),
      row("Has", { metricsByWeek: { w: { intros_corofy: 2, interested_corofy: 3 } } }),
    ]],
  ];
  for (const [col, rows] of cases) {
    for (const order of both(rows, col)) {
      assert.equal(order.at(-1), "None", `${col} floated a missing value to the top`);
    }
  }
});

test("monthly compares progress, and an unset target is not 'furthest behind'", () => {
  const rows = [
    row("Unset"),
    row("Behind", { monthly_target: 10, intros_this_month: 1 }),
    row("Ahead", { monthly_target: 10, intros_this_month: 9 }),
  ];
  assert.deepEqual(names(sortWeekly(rows, { col: "monthly", dir: "desc" }, NOW)), ["Ahead", "Behind", "Unset"]);
  assert.deepEqual(names(sortWeekly(rows, { col: "monthly", dir: "asc" }, NOW)), ["Behind", "Ahead", "Unset"]);
});

test("descending Last Intro means MOST RECENT first, not longest ago", () => {
  // daysSince counts the wrong way round, so this is easy to invert by mistake
  // — and inverting it silently answers the opposite question.
  const rows = [row("Old", {}, { daysSince: 30 }), row("Fresh", {}, { daysSince: 1 })];
  assert.deepEqual(names(sortWeekly(rows, { col: "lastIntro", dir: "desc" }, NOW)), ["Fresh", "Old"]);
  assert.deepEqual(names(sortWeekly(rows, { col: "lastIntro", dir: "asc" }, NOW)), ["Old", "Fresh"]);
});

test("billing sorts by the NEXT date, which recurs from the anchor", () => {
  // An anchor is the first billing day. 09-01 biweekly next bills on the 15th;
  // 09-08 not until the 22nd — so 09-01 is sooner despite being earlier.
  const rows = [
    row("Later", { billing_anchor_date: "2026-09-08" }),
    row("Sooner", { billing_anchor_date: "2026-09-01" }),
  ];
  assert.deepEqual(names(sortWeekly(rows, { col: "billing", dir: "asc" }, NOW)), ["Sooner", "Later"]);
});

test("numeric columns sort straightforwardly and reverse", () => {
  for (const [col, field] of [["emails", "emails"], ["intros", "intros"], ["leftWeek", "leftThisWeek"], ["progress", "campaignsAvgPct"]] as const) {
    const rows = [row("low", {}, { [field]: 1 }), row("high", {}, { [field]: 9 })];
    assert.deepEqual(names(sortWeekly(rows, { col, dir: "desc" }, NOW)), ["high", "low"], col);
    assert.deepEqual(names(sortWeekly(rows, { col, dir: "asc" }, NOW)), ["low", "high"], col);
  }
});

test("interested and converted sum across every loaded week", () => {
  const rows = [
    row("A", { metricsByWeek: { w1: { interested_corofy: 1, intros_corofy: 5 }, w2: { interested_corofy: 1, intros_corofy: 0 } } }),
    row("B", { metricsByWeek: { w1: { interested_corofy: 9, intros_corofy: 1 } } }),
  ];
  assert.deepEqual(names(sortWeekly(rows, { col: "interested", dir: "desc" }, NOW)), ["B", "A"]);
  assert.deepEqual(names(sortWeekly(rows, { col: "converted", dir: "desc" }, NOW)), ["A", "B"]);
});

test("today's emails count only when the stored date IS today", () => {
  // Yesterday's figure left in the column would read as today's activity.
  const rows = [
    row("Stale", { emails_today: 900, emails_today_date: "2026-09-08" }),
    row("Fresh", { emails_today: 10, emails_today_date: "2026-09-09" }),
  ];
  assert.deepEqual(names(sortWeekly(rows, { col: "today", dir: "desc" }, NOW)), ["Fresh", "Stale"]);
});

test("campaigns rank by running first, then by how many there are", () => {
  const rows = [
    row("ManyIdle", { campaigns: [{ status: "paused" }, { status: "paused" }, { status: "paused" }] }),
    row("OneRunning", { campaigns: [{ status: "running" }] }),
  ];
  assert.deepEqual(names(sortWeekly(rows, { col: "campaigns", dir: "desc" }, NOW)), ["OneRunning", "ManyIdle"]);
});

test("ties fall back to name order rather than an arbitrary one", () => {
  // Without this, equal rows shuffle between renders for no reason.
  const rows = [row("Zulu"), row("Alpha"), row("Mike")];
  assert.deepEqual(names(sortWeekly(rows, { col: "emails", dir: "desc" }, NOW)), ["Alpha", "Mike", "Zulu"]);
});

test("no sort returns the rows untouched, and sorting never mutates", () => {
  const rows = [row("B", {}, { emails: 1 }), row("A", {}, { emails: 9 })];
  assert.deepEqual(names(sortWeekly(rows, null, NOW)), ["B", "A"]);
  sortWeekly(rows, { col: "emails", dir: "desc" }, NOW);
  assert.deepEqual(names(rows), ["B", "A"], "the caller's array was reordered");
});
