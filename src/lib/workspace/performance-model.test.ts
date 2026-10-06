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
