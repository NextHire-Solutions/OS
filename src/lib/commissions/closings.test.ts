/*
 * Closings by month and the service month (13 Oct) — the Commissions chart's
 * arithmetic, with no clock in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { axisTop, closingsByMonth, serviceMonth, windowStart, type Closing } from "./closings.ts";

const TODAY = "2026-10-13";
const c = (name: string, date: string, status = "active"): Closing => ({ id: name, name, status, date });
const CLOSINGS = [
  c("Old Co", "2025-11-03", "churned"),
  c("Acme", "2026-02-10"),
  c("Beta", "2026-02-27", "paused"),
  c("Cedar", "2026-08-01"),
  c("Delta", "2026-10-02"),
  c("Echo", "2026-10-09", "churned"),
];

test("each window starts where its name says and always ends this month", () => {
  assert.equal(windowStart("6m", TODAY, CLOSINGS), "2026-05");
  assert.equal(windowStart("12m", TODAY, CLOSINGS), "2025-11");
  assert.equal(windowStart("ytd", TODAY, CLOSINGS), "2026-01");
  assert.equal(windowStart("all", TODAY, CLOSINGS), "2025-11");
  assert.equal(windowStart("all", TODAY, []), "2026-10", "nothing closed: just this month");
  for (const w of ["6m", "12m", "ytd", "all"] as const) assert.equal(closingsByMonth(CLOSINGS, w, "all", TODAY).at(-1)!.month, "2026-10");
});

test("one bar per month with no gaps — a quiet month is a zero, not a missing bar", () => {
  const m = closingsByMonth(CLOSINGS, "12m", "all", TODAY);
  assert.equal(m.length, 12);
  assert.deepEqual(m.map((x) => x.clients.length), [1, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 2]);
  assert.deepEqual(m.map((x) => x.month).slice(0, 3), ["2025-11", "2025-12", "2026-01"]);
  assert.equal(m.reduce((n, x) => n + x.clients.length, 0), CLOSINGS.length);
});

test("the six-month window drops what was closed before it", () => {
  const m = closingsByMonth(CLOSINGS, "6m", "all", TODAY);
  assert.equal(m.length, 6);
  assert.deepEqual(m.flatMap((x) => x.clients.map((y) => y.name)), ["Cedar", "Delta", "Echo"]);
});

test("the status filter answers 'how many of them are still with us'", () => {
  const names = (s: "all" | "active" | "paused" | "churned") => closingsByMonth(CLOSINGS, "all", s, TODAY).flatMap((x) => x.clients.map((y) => y.name));
  assert.deepEqual(names("active"), ["Acme", "Cedar", "Delta"]);
  assert.deepEqual(names("paused"), ["Beta"]);
  assert.deepEqual(names("churned"), ["Old Co", "Echo"]);
  assert.equal(names("all").length, 6);
  // The bars stay the same months whatever the filter — only their heights change.
  assert.equal(closingsByMonth(CLOSINGS, "all", "paused", TODAY).length, closingsByMonth(CLOSINGS, "all", "all", TODAY).length);
});

test("within a month, clients are in the order they signed", () => {
  const oct = closingsByMonth(CLOSINGS, "6m", "all", TODAY).at(-1)!;
  assert.deepEqual(oct.clients.map((x) => x.name), ["Delta", "Echo"]);
  assert.equal(oct.long, "October 2026");
});

test("labels carry the year on the first bar and on every January", () => {
  const m = closingsByMonth(CLOSINGS, "12m", "all", TODAY);
  assert.equal(m[0].label, "Nov ’25");
  assert.equal(m[1].label, "Dec");
  assert.equal(m[2].label, "Jan ’26");
  assert.equal(m[11].label, "Oct");
});

test("the axis tops out on a whole number of clients", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 7, 10, 11, 23].map(axisTop), [1, 1, 2, 4, 4, 5, 10, 10, 20, 50]);
});

test("service month: Month 1 from the first payment, a new month every 28 days", () => {
  assert.equal(serviceMonth("2026-09-01", "2026-09-01"), 1);
  assert.equal(serviceMonth("2026-09-01", "2026-09-28"), 1, "day 27 is still Month 1");
  assert.equal(serviceMonth("2026-09-01", "2026-09-29"), 2, "day 28 starts Month 2 — when the account manager starts earning");
  assert.equal(serviceMonth("2026-06-24", "2026-09-30"), 4);
  assert.equal(serviceMonth(null, "2026-09-30"), null);
  assert.equal(serviceMonth("2026-10-05", "2026-09-30"), null, "a first payment after the payout is not a month yet");
});
