import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RATES, commissionLines, easternDay, estimatedPayments, linesForRun, nextRun, previousRun,
  runForPayment, runOnOrAfter, statusAt, sum, type Payment,
} from "./schedule.ts";

const pay = (date: string, amount: number, source: Payment["source"] = "stripe"): Payment => ({ date, amount, source });

test("payout runs are the 1st and the 15th; a payment is paid on the first run AFTER its day", () => {
  assert.equal(runOnOrAfter("2026-09-30"), "2026-10-01");
  assert.equal(runOnOrAfter("2026-10-01"), "2026-10-01");
  assert.equal(runOnOrAfter("2026-10-02"), "2026-10-15");
  assert.equal(runOnOrAfter("2026-12-20"), "2027-01-01");
  assert.equal(runForPayment("2026-09-14"), "2026-09-15");
  assert.equal(runForPayment("2026-09-15"), "2026-10-01", "billed ON a run day waits for the next run");
  assert.equal(runForPayment("2026-09-30"), "2026-10-01");
  assert.equal(nextRun("2026-10-15"), "2026-11-01");
  assert.equal(previousRun("2026-10-01"), "2026-09-15");
  assert.equal(previousRun("2027-01-01"), "2026-12-15");
});

test("Eastern day: a late-evening Eastern charge is that Eastern day, not tomorrow's UTC date", () => {
  assert.equal(easternDay("2026-09-15T02:30:00Z"), "2026-09-14");
  assert.equal(easternDay("2026-09-15T16:00:00Z"), "2026-09-15");
});

test("14-day client: the first two payments are Month 1 at 70%, later ones residual at the rep's rate", () => {
  const lines = commissionLines(
    [pay("2026-08-03", 1500), pay("2026-08-17", 1500), pay("2026-08-31", 1500), pay("2026-09-14", 1500)],
    [], "active", { monthOne: 0.7, residual: 0.25 },
  );
  assert.deepEqual(lines.map((l) => [l.kind, l.commission]), [["month1", 1050], ["month1", 1050], ["residual", 375], ["residual", 375]]);
});

test("28-day client: one Month 1 payment, then residual", () => {
  const lines = commissionLines([pay("2026-07-01", 1000), pay("2026-07-29", 1000)], [], "active", DEFAULT_RATES);
  assert.deepEqual(lines.map((l) => [l.kind, l.commission]), [["month1", 700], ["residual", 150]]);
});

test("cancellation: nothing accrues from the churn day on; earlier payments still count", () => {
  const changes = [{ from: "active", to: "churned", at: "2026-09-03T15:00:00Z" }];
  const lines = commissionLines(
    [pay("2026-08-20", 800), pay("2026-09-03", 800), pay("2026-09-17", 800)], changes, "churned", DEFAULT_RATES,
  );
  assert.deepEqual(lines.map((l) => l.date), ["2026-08-20"]);
});

test("estimates earn nothing while paused; a paused Stripe client simply has no paid invoices", () => {
  const changes = [
    { from: "active", to: "paused", at: "2026-09-01T12:00:00Z" },
    { from: "paused", to: "active", at: "2026-09-20T12:00:00Z" },
  ];
  const est = estimatedPayments(["2026-08-18", "2026-09-01", "2026-09-15", "2026-09-29"], 1500, 14);
  assert.deepEqual(est.map((p) => p.amount), [750, 750, 750, 750], "gross per 28 days, split over two 14-day payments");
  const lines = commissionLines(est, changes, "active", DEFAULT_RATES);
  assert.deepEqual(lines.map((l) => l.date), ["2026-08-18", "2026-09-29"]);
});

test("a client already churned when history began still earns on what it paid before then", () => {
  const seeded = [{ from: null, to: "churned", at: "2026-09-13T12:00:00Z" }];
  const lines = commissionLines([pay("2026-08-01", 1000), pay("2026-09-20", 1000)], seeded, "churned", DEFAULT_RATES);
  assert.deepEqual(lines.map((l) => l.date), ["2026-08-01"], "paid before the record counts; after the churn record does not");
});

test("status history: before the first record the client was being served", () => {
  const changes = [
    { from: null, to: "active", at: "2026-09-13T00:00:00Z" },
    { from: "active", to: "paused", at: "2026-09-20T00:00:00Z" },
  ];
  assert.equal(statusAt(changes, "paused", "2026-09-10"), "active");
  assert.equal(statusAt(changes, "paused", "2026-09-25"), "paused");
  assert.equal(statusAt([], "active", "2026-01-01"), "active");
});

test("a run pays exactly the payments billed since the previous run", () => {
  const lines = commissionLines(
    [pay("2026-09-01", 1000), pay("2026-09-15", 1000), pay("2026-09-29", 1000), pay("2026-10-13", 1000)],
    [], "active", DEFAULT_RATES,
  );
  assert.deepEqual(linesForRun(lines, "2026-09-15").map((l) => l.date), ["2026-09-01"]);
  assert.deepEqual(linesForRun(lines, "2026-10-01").map((l) => l.date), ["2026-09-15", "2026-09-29"]);
  assert.equal(sum(linesForRun(lines, "2026-10-01")), 850, "one Month 1 (700) + one residual (150)");
  assert.equal(sum(linesForRun(lines, "2026-10-15")), 150);
});
