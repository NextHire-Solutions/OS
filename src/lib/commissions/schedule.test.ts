import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commissionLines, easternDay, estimatedPayments, linesForRun, netPer28, nextRun, previousRun,
  runForPayment, runOnOrAfter, salespersonRate, statusAt, stripeFee, sum, type Payment,
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

test("every payment earns a flat rate of what is left after Stripe's fee — no Month 1 rate", () => {
  const lines = commissionLines([pay("2026-08-03", 1500), pay("2026-08-17", 1500), pay("2026-09-14", 1500)], [], "active", 0.2);
  assert.deepEqual(lines.map((l) => [l.fee, l.net, l.commission]), [[43.8, 1456.2, 291.24], [43.8, 1456.2, 291.24], [43.8, 1456.2, 291.24]]);
  assert.deepEqual(commissionLines([pay("2026-08-03", 1500)], [], "active", 0.05).map((l) => l.commission), [72.81], "account manager 5%");
  assert.deepEqual(commissionLines([pay("2026-08-03", 1500)], [], "active", 0.1).map((l) => l.commission), [145.62], "salesperson 10%");
});

test("account manager: nothing on the first 28 days of billing, 5% from Month 2", () => {
  const pays = [pay("2026-08-03", 1500), pay("2026-08-17", 1500), pay("2026-08-31", 1500), pay("2026-09-14", 1500)];
  assert.deepEqual(commissionLines(pays, [], "active", 0.05, { fromMonthTwo: true }).map((l) => [l.date, l.commission]),
    [["2026-08-31", 72.81], ["2026-09-14", 72.81]], "Aug 3 and Aug 17 are Month 1 (until Aug 31)");
  assert.equal(commissionLines(pays, [], "active", 0.2).length, 4, "the salesperson earns from the first payment");
});

test("Stripe's fee is 2.9% + $0.30 per charge; the monthly net counts one fee per charge", () => {
  assert.equal(stripeFee(1500), 43.8);
  assert.equal(stripeFee(0), 0);
  assert.equal(netPer28(3000, 14), 2912.4, "14-day billing: two charges of $1,500");
  assert.equal(netPer28(1000, 28), 970.7);
  assert.equal(netPer28(1000, null), 970.7, "monthly billing: one charge");
});

test("a salesperson is on 20% or 10%; anything else stored (the old 15% / 25%) reads as 20%", () => {
  assert.equal(salespersonRate(0.1), 0.1);
  assert.equal(salespersonRate(0.2), 0.2);
  assert.equal(salespersonRate(0.15), 0.2);
  assert.equal(salespersonRate(null), 0.2);
});

test("cancellation: nothing accrues from the churn day on; earlier payments still count", () => {
  const changes = [{ from: "active", to: "churned", at: "2026-09-03T15:00:00Z" }];
  const lines = commissionLines(
    [pay("2026-08-20", 800), pay("2026-09-03", 800), pay("2026-09-17", 800)], changes, "churned", 0.2,
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
  const lines = commissionLines(est, changes, "active", 0.2);
  assert.deepEqual(lines.map((l) => l.date), ["2026-08-18", "2026-09-29"]);
});

test("a client already churned when history began still earns on what it paid before then", () => {
  const seeded = [{ from: null, to: "churned", at: "2026-09-13T12:00:00Z" }];
  const lines = commissionLines([pay("2026-08-01", 1000), pay("2026-09-20", 1000)], seeded, "churned", 0.2);
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
    [], "active", 0.2,
  );
  assert.deepEqual(linesForRun(lines, "2026-09-15").map((l) => l.date), ["2026-09-01"]);
  assert.deepEqual(linesForRun(lines, "2026-10-01").map((l) => l.date), ["2026-09-15", "2026-09-29"]);
  assert.equal(sum(linesForRun(lines, "2026-10-01")), 388.28, "two payments: 20% of ($1,000 − $29.30) each");
  assert.equal(sum(linesForRun(lines, "2026-10-15")), 194.14);
});
