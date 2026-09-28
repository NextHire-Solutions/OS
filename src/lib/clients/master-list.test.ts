import assert from "node:assert/strict";
import { test } from "node:test";

import { firstBillingDate, lifecycleDates } from "./master-list.ts";

test("first billing date: the first cycle date on or after the start date", () => {
  // 14-day cycle anchored 2026-09-16; started 2026-08-25 → first charge 2026-09-02.
  assert.equal(firstBillingDate({ start_date: "2026-08-25", billing_anchor_date: "2026-09-16", billing_interval: "biweekly", billing_interval_days: null }), "2026-09-02");
  // Starting ON a billing day bills that day.
  assert.equal(firstBillingDate({ start_date: "2026-09-02", billing_anchor_date: "2026-09-16", billing_interval: "biweekly", billing_interval_days: null }), "2026-09-02");
  // 28-day cycles.
  assert.equal(firstBillingDate({ start_date: "2026-08-01", billing_anchor_date: "2026-09-23", billing_interval: "28-days", billing_interval_days: null }), "2026-08-26");
  // No schedule → no date, never a guess.
  assert.equal(firstBillingDate({ start_date: null, billing_anchor_date: null, billing_interval: "biweekly", billing_interval_days: null }), null);
});

test("lifecycle dates: latest pause and churn, reactivation only from paused/churned, seeded rows ignored", () => {
  const d = lifecycleDates([
    { from: null, to: "active", at: "2026-09-01T00:00:00Z" },          // seeded 0012 row — not a change
    { from: "active", to: "paused", at: "2026-09-05T00:00:00Z" },
    { from: "paused", to: "active", at: "2026-09-10T00:00:00Z" },       // reactivation
    { from: "active", to: "paused", at: "2026-09-20T00:00:00Z" },       // later pause wins
    { from: "paused", to: "churned", at: "2026-09-25T00:00:00Z" },
    { from: "onboarding", to: "active", at: "2026-08-01T00:00:00Z" },   // onboarding → active is NOT a reactivation
  ]);
  assert.equal(d.pauseDate, "2026-09-20T00:00:00Z");
  assert.equal(d.churnDate, "2026-09-25T00:00:00Z");
  assert.equal(d.reactivationDate, "2026-09-10T00:00:00Z");
  assert.equal(d.onboardingDate, null);
  assert.deepEqual(lifecycleDates([]), { pauseDate: null, churnDate: null, reactivationDate: null, onboardingDate: null });
});
