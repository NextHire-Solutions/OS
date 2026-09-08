/*
 * The Bi-Weekly and Client Success row models.
 *
 * The arithmetic here is the kind that is wrong by one for months before
 * anybody notices, because a plausible-looking number invites no scrutiny. The
 * two that matter most:
 *
 *   cycle target   a monthly client's target is four weeks of work, not the
 *                  flat fortnightly number. Get it wrong and every monthly
 *                  client permanently reads as missing target by half.
 *
 *   null score     a client too new to score must not sort or render as 0.0.
 *                  "Not enough history" and "scored badly" prompt opposite
 *                  actions from whoever reads the screen.
 *
 *   node --test src/lib/tools/client-health/views.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  biweeklyRows, sortBiWeekly, cycleDays,
  successRows, sortSuccess, scoreTone,
  humanizeAgo, fmtDateShort, fmtDateUTC,
} from "./views.ts";
import type { DashboardClient } from "./types.ts";

const NOW = new Date("2026-09-09T00:00:00Z");

function client(name: string, o: Record<string, unknown> = {}): DashboardClient {
  return {
    id: name, name,
    plan: "minimum", weekly_target: 1,
    hidden: false, client_paused: false,
    start_date: "2026-01-05",
    billing_anchor_date: null, billing_interval: "biweekly", billing_interval_days: null,
    intros_since_last_billing: 0,
    time_zone: null,
    last_lead_activity_at: null,
    stagnant_intros_count: 0, dnc_count: 0, agents_count: 0,
    campaigns: [], bisonCampaigns: [], metricsByWeek: {},
    ...o,
  } as unknown as DashboardClient;
}

const names = <T extends { client: { name: string } }>(rows: T[]) => rows.map((r) => r.client.name);

// -- cycle length ------------------------------------------------------------

test("cycle length follows the billing interval", () => {
  assert.equal(cycleDays(client("a", { billing_interval: "biweekly" })), 14);
  assert.equal(cycleDays(client("a", { billing_interval: "28-days" })), 28);
  assert.equal(cycleDays(client("a", { billing_interval: "monthly" })), 30);
});

test("a custom interval uses its own day count, and falls back when unset", () => {
  assert.equal(cycleDays(client("a", { billing_interval: "custom", billing_interval_days: 21 })), 21);
  assert.equal(cycleDays(client("a", { billing_interval: "custom", billing_interval_days: null })), 14);
});

test("a monthly client's cycle target is four weeks of work, not two", () => {
  // The mistake that would make every monthly client look permanently behind.
  const [biweekly] = biweeklyRows([client("A", { weekly_target: 3 })], NOW);
  const [monthly] = biweeklyRows([client("B", { weekly_target: 3, billing_interval: "monthly" })], NOW);
  assert.equal(biweekly.target, 6);   // 3 × 14/7
  assert.equal(monthly.target, 13);   // 3 × 30/7, rounded
});

test("a cycle target is never zero, however small the weekly target", () => {
  // A target of 0 would make "0/0" read as complete for a client doing nothing.
  const [r] = biweeklyRows([client("A", { weekly_target: 0 })], NOW);
  assert.equal(r.target, 1);
});

test("introductions left never goes negative when a client overdelivers", () => {
  const [r] = biweeklyRows([client("A", { weekly_target: 1, intros_since_last_billing: 99 })], NOW);
  assert.equal(r.leftCycle, 0);
});

// -- billing dates -----------------------------------------------------------

test("the billing anchor wins over the start date when both are set", () => {
  const withAnchor = biweeklyRows([client("A", { start_date: "2026-01-05", billing_anchor_date: "2026-09-07" })], NOW)[0];
  const withoutAnchor = biweeklyRows([client("A", { start_date: "2026-01-05" })], NOW)[0];
  assert.notDeepEqual(withAnchor.billing, withoutAnchor.billing);
});

test("a client with no anchor and no start date has no billing date", () => {
  const [r] = biweeklyRows([client("A", { start_date: null })], NOW);
  assert.equal(r.billing, null);
  assert.equal(r.days, null);
});

test("the billing date recurs from the anchor rather than being the anchor", () => {
  // An anchor is the first billing day, not the next one. Reading it as the
  // next one would show a date in the past for every long-standing client.
  const [r] = biweeklyRows([client("A", { billing_anchor_date: "2026-09-01" })], NOW);
  assert.equal(fmtDateUTC(r.billing!), "09/15/2026", "should roll forward a whole cycle");
  assert.equal(r.days, 6);
});

test("default order is soonest billing first, with unset dates last", () => {
  // The screen exists to answer "who bills next", so this is the useful default.
  // Anchors recur: 09-01 next bills on the 15th, 09-08 not until the 22nd.
  const rows = biweeklyRows([
    client("NoDate", { start_date: null }),
    client("Sooner", { billing_anchor_date: "2026-09-01" }),
    client("Later", { billing_anchor_date: "2026-09-08" }),
  ], NOW);
  assert.deepEqual(rows.map((r) => r.days), [null, 6, 13]);
  assert.deepEqual(names(sortBiWeekly(rows, null)), ["Sooner", "Later", "NoDate"]);
});

test("clients with no billing date sink to the bottom in either direction", () => {
  const rows = biweeklyRows([
    client("NoDate", { start_date: null }),
    client("Dated", { billing_anchor_date: "2026-09-08" }),
  ], NOW);
  for (const dir of ["desc", "asc"] as const) {
    assert.equal(names(sortBiWeekly(rows, { col: "days", dir })).at(-1), "NoDate");
  }
});

test("sorting by name descending is Z to A", () => {
  const rows = biweeklyRows([client("Alpha"), client("Zulu")], NOW);
  assert.deepEqual(names(sortBiWeekly(rows, { col: "name", dir: "desc" })), ["Zulu", "Alpha"]);
  assert.deepEqual(names(sortBiWeekly(rows, { col: "name", dir: "asc" })), ["Alpha", "Zulu"]);
});

test("sorting does not mutate the caller's array", () => {
  const rows = biweeklyRows([client("B"), client("A")], NOW);
  const before = names(rows);
  sortBiWeekly(rows, { col: "name", dir: "desc" });
  assert.deepEqual(names(rows), before);
});

test("a known time zone renders as its short code, an unknown one as itself", () => {
  const rows = biweeklyRows([
    client("A", { time_zone: "America/New_York" }),
    client("B", { time_zone: "Europe/Lisbon" }),
    client("C"),
  ], NOW);
  assert.equal(rows[0].tzShort, "ET");
  assert.equal(rows[1].tzShort, "Europe/Lisbon");
  assert.equal(rows[2].tzShort, null);
});

// -- Client Success ----------------------------------------------------------

test("hires are summed across weeks and the latest hire date wins", () => {
  const [r] = successRows([client("A", {
    metricsByWeek: {
      "2026-08-24": { hired_corofy: 2, last_hired_at: "2026-08-26T10:00:00Z" },
      "2026-08-31": { hired_corofy: 3, last_hired_at: "2026-09-02T10:00:00Z" },
    },
  })], NOW);
  assert.equal(r.hiredTotal, 5);
  assert.equal(r.lastHireAt, "2026-09-02T10:00:00.000Z");
});

test("a client with no hires has no last-hire date rather than the epoch", () => {
  const [r] = successRows([client("A")], NOW);
  assert.equal(r.hiredTotal, 0);
  assert.equal(r.lastHireAt, null);
});

test("a client with too little history has no score, not a zero", () => {
  // Sorting or rendering this as 0.0 would read as "scored badly" when the
  // truth is "we do not know yet" — opposite actions for whoever reads it.
  const [r] = successRows([client("New", { metricsByWeek: {} })], NOW);
  assert.equal(r.score, null);
});

test("unscored clients sink to the bottom in either direction", () => {
  const scored = client("Scored", {
    weekly_target: 1,
    metricsByWeek: Object.fromEntries(
      ["2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10"].map((k) => [k, { intros_corofy: 2 }]),
    ),
  });
  const rows = successRows([client("New"), scored], NOW);
  assert.notEqual(rows.find((r) => r.client.name === "Scored")?.score, null);
  for (const dir of ["desc", "asc"] as const) {
    assert.equal(names(sortSuccess(rows, { col: "score", dir })).at(-1), "New");
  }
});

test("ties fall back to name order rather than an arbitrary one", () => {
  // Without the fallback, rows would shuffle between renders on equal values.
  const rows = successRows([client("Zulu"), client("Alpha"), client("Mike")], NOW);
  assert.deepEqual(names(sortSuccess(rows, { col: "dnc", dir: "desc" })), ["Alpha", "Mike", "Zulu"]);
});

test("missing values sort last for text and date columns alike", () => {
  const rows = successRows([
    client("NoTz"),
    client("HasTz", { time_zone: "America/Denver" }),
  ], NOW);
  assert.equal(names(sortSuccess(rows, { col: "tz", dir: "desc" })).at(-1), "NoTz");
  const dated = successRows([client("NoDate", { start_date: null }), client("Dated")], NOW);
  assert.equal(names(sortSuccess(dated, { col: "launch", dir: "desc" })).at(-1), "NoDate");
});

test("score colour cutoffs are 8 and 5", () => {
  assert.equal(scoreTone(9.9), "good");
  assert.equal(scoreTone(8), "good");
  assert.equal(scoreTone(7.9), "mid");
  assert.equal(scoreTone(5), "mid");
  assert.equal(scoreTone(4.9), "low");
});

// -- formatting --------------------------------------------------------------

test("relative times read the way the tool words them", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const ago = (iso: string) => humanizeAgo(iso, now);
  assert.equal(ago("2026-09-09T11:59:30Z"), "just now");
  assert.equal(ago("2026-09-09T11:30:00Z"), "30 min ago");
  assert.equal(ago("2026-09-09T09:00:00Z"), "3h ago");
  assert.equal(ago("2026-09-08T12:00:00Z"), "Yesterday");
  assert.equal(ago("2026-09-04T12:00:00Z"), "5d ago");
  assert.equal(ago("2026-07-01T12:00:00Z"), "2mo ago");
  assert.equal(ago("2024-09-09T12:00:00Z"), "2y ago");
});

test("a missing or unparseable timestamp is an em dash, never 'just now'", () => {
  // A garbled date rendering as "just now" would be a confident lie.
  assert.equal(humanizeAgo(null), "—");
  assert.equal(humanizeAgo(undefined), "—");
  assert.equal(humanizeAgo("not a date"), "—");
});

test("a future timestamp clamps to 'just now' rather than going negative", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  assert.equal(humanizeAgo("2026-09-09T18:00:00Z", now), "just now");
});

test("dates format in UTC, so a calendar day never shifts by one", () => {
  // Rendering "2026-09-09" in a western timezone as local time would show the
  // 8th — which is how billing dates silently drift by a day.
  assert.equal(fmtDateShort("2026-09-09"), "09/09/2026");
  assert.equal(fmtDateUTC(new Date("2026-01-05T00:00:00Z")), "01/05/2026");
  assert.equal(fmtDateShort(null), "—");
  assert.equal(fmtDateShort("nonsense"), "—");
});
