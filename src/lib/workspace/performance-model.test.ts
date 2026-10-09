import assert from "node:assert/strict";
import { test } from "node:test";

import { performanceFrom, type PerfClient } from "./performance-model.ts";

const c = (status: string, onboardingDate: string | null, churnDate: string | null = null, signupDate: string | null = null, plan = "production"): PerfClient =>
  ({ status, plan, weeklyTarget: 2, onboardingDate, signupDate, churnDate });

const TODAY = new Date("2026-09-30T12:00:00Z");

test("added, churned, net and active at month end come from the two dates", () => {
  const p = performanceFrom([
    c("active", "2026-07-10"),
    c("churned", "2026-07-20", "2026-08-15"),
    c("active", null, null, "2026-08-02"),       // no onboarding date: placed by sign-up date
    c("churned", "2026-06-01", null),              // churned, no churn date: not placed as churn
    c("paused", null),                             // no date at all: undated
  ], new Map([["2026-08", 3000], ["2026-09", 1500]]), null, 3, TODAY);
  const by = Object.fromEntries(p.months.map((m) => [m.month, m]));
  assert.deepEqual([by["2026-07"].added, by["2026-07"].churned, by["2026-07"].net, by["2026-07"].activeAtEnd], [2, 0, 2, 3]);
  assert.deepEqual([by["2026-08"].added, by["2026-08"].churned, by["2026-08"].net, by["2026-08"].activeAtEnd], [1, 1, 0, 3]);
  assert.equal(by["2026-08"].revenue, 3000);
  assert.equal(by["2026-09"].revenue, 1500);
  assert.equal(p.months[0].month, "2026-09", "newest first, and months with no movement are still listed");
  assert.equal(p.totals.undated, 1);
  assert.equal(p.totals.bySignupDate, 1);
  assert.equal(p.totals.churnUndated, 1);
  assert.equal(p.totals.revenueThisMonth, 1500);
  assert.equal(p.totals.churnedLast90, 1);
});

test("revenue unknown when Stripe could not be read — never a zero", () => {
  const p = performanceFrom([c("active", "2026-09-01")], null, null, 1, TODAY);
  assert.equal(p.months[0].revenue, null);
  assert.equal(p.totals.revenueThisMonth, null);
});

test("a reactivated client (active again) is not counted as churned even with an old churn date", () => {
  const p = performanceFrom([c("active", "2026-06-01", "2026-07-01")], new Map(), null, 0, TODAY);
  assert.equal(p.months.find((m) => m.month === "2026-07")!.churned, 0);
  assert.equal(p.totals.churned, 0);
});

test("this month, a churned client is not active even before its churn date is entered", () => {
  const p = performanceFrom([c("active", "2026-06-01"), c("churned", "2026-06-01", null)], new Map(), null, 0, TODAY);
  assert.equal(p.months.find((m) => m.month === "2026-09")!.activeAtEnd, 1);
  assert.equal(p.months.find((m) => m.month === "2026-08")!.activeAtEnd, 2, "earlier months cannot know without the date");
});

test("this month counts only clients that are active now — paused and onboarding are not", () => {
  const p = performanceFrom([c("active", "2026-06-01"), c("paused", "2026-06-01"), c("onboarding", "2026-09-20")], new Map(), null, 0, TODAY);
  assert.equal(p.months.find((m) => m.month === "2026-09")!.activeAtEnd, 1);
});

test("Paused: each client once a month it was paused in, from history and entered dates (9 Oct)", () => {
  const p = (status: string, pauseDates: string[]): PerfClient => ({ ...c(status, "2026-05-01"), pauseDates });
  const r = performanceFrom([
    p("paused", ["2026-07-14"]),                      // entered by hand: before the history began
    p("active", ["2026-09-03", "2026-09-20"]),        // paused twice in September → once
    p("churned", ["2026-08-30", "2026-09-02"]),       // paused in August AND September
    p("paused", []),                                  // paused now, no known pause → undated
  ], new Map(), null, 0, TODAY);
  const by = Object.fromEntries(r.months.map((m) => [m.month, m]));
  assert.equal(by["2026-07"].paused, 1);
  assert.equal(by["2026-08"].paused, 1);
  assert.equal(by["2026-09"].paused, 2);
  assert.equal(by["2026-06"].paused, 0);
  assert.equal(r.totals.pauseUndated, 1);
  assert.equal(r.totals.pausedLast90, 3, "anyone paused since 2 Jul");
  // Paused does not change Net — a paused client is still a client.
  assert.equal(by["2026-09"].net, by["2026-09"].added - by["2026-09"].churned);
});

test("Paused is unknown, not zero, when the status history cannot be read", () => {
  const r = performanceFrom([{ ...c("paused", "2026-05-01"), pauseDates: ["2026-07-14"] }], new Map(), null, 0, TODAY, false);
  assert.ok(r.months.every((m) => m.paused === null));
  assert.equal(r.totals.pausedLast90, null);
});

test("a pause alone can open the month list", () => {
  const r = performanceFrom([{ ...c("paused", null), pauseDates: ["2026-03-10"] }], null, null, 0, TODAY);
  assert.equal(r.months.at(-1)!.month, "2026-03");
});
