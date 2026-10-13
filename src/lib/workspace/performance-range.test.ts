/*
 * The Performance page's date filter and RANGE tiles (wireframe, 11 Oct).
 * Days are plain strings, so every case here is exact and needs no clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRESET,
  RANGE_PRESETS,
  addDays,
  compareRange,
  rangeDays,
  rangeLabel,
  rangeTiles,
  resolveRange,
  revenuePerAccount,
  sumDays,
  type RangeClient,
} from "./performance-range.ts";

const TODAY = "2026-10-11";
const EARLIEST = "2025-03-04";

test("the presets are the wireframe's, and YTD is the default", () => {
  assert.deepEqual(RANGE_PRESETS.map((p) => p.label), ["This month", "Last 30 days", "Last 90 days", "YTD", "All time"]);
  assert.equal(DEFAULT_PRESET, "ytd");
});

test("each preset ends today and starts where its name says", () => {
  assert.deepEqual(resolveRange("month", TODAY, EARLIEST), { from: "2026-10-01", to: TODAY });
  assert.deepEqual(resolveRange("30d", TODAY, EARLIEST), { from: "2026-09-12", to: TODAY });
  assert.equal(rangeDays(resolveRange("30d", TODAY, EARLIEST)), 30, "thirty days, counting today");
  assert.equal(rangeDays(resolveRange("90d", TODAY, EARLIEST)), 90);
  assert.deepEqual(resolveRange("ytd", TODAY, EARLIEST), { from: "2026-01-01", to: TODAY });
  assert.deepEqual(resolveRange("all", TODAY, EARLIEST), { from: EARLIEST, to: TODAY });
});

test("a custom range is taken as given — swapped if backwards, never past today, YTD until both ends are in", () => {
  assert.deepEqual(resolveRange("custom", TODAY, EARLIEST, { from: "2026-01-01", to: "2026-10-11" }), { from: "2026-01-01", to: "2026-10-11" });
  assert.deepEqual(resolveRange("custom", TODAY, EARLIEST, { from: "2026-06-30", to: "2026-06-01" }), { from: "2026-06-01", to: "2026-06-30" });
  assert.deepEqual(resolveRange("custom", TODAY, EARLIEST, { from: "2026-10-01", to: "2026-12-31" }), { from: "2026-10-01", to: TODAY });
  assert.deepEqual(resolveRange("custom", TODAY, EARLIEST, { from: "2026-11-01", to: "2026-12-31" }), { from: TODAY, to: TODAY });
  for (const half of [null, {}, { from: "2026-02-01" }, { from: "nonsense", to: "2026-03-01" }, { from: "2026-02-31", to: "2026-03-01" }]) {
    assert.deepEqual(resolveRange("custom", TODAY, EARLIEST, half), { from: "2026-01-01", to: TODAY }, JSON.stringify(half));
  }
});

test("compare: the previous period is the same length and ends the day before", () => {
  const ytd = resolveRange("ytd", TODAY, EARLIEST);
  const prev = compareRange(ytd, "previous");
  assert.equal(rangeDays(prev), rangeDays(ytd));
  assert.equal(prev.to, "2025-12-31");
  assert.equal(addDays(prev.to, 1), ytd.from);
  assert.deepEqual(compareRange({ from: "2026-10-01", to: "2026-10-11" }, "previous"), { from: "2026-09-20", to: "2026-09-30" });
});

test("compare: the same period last year is the same dates, and 29 Feb has somewhere to go", () => {
  assert.deepEqual(compareRange({ from: "2026-01-01", to: "2026-10-11" }, "year"), { from: "2025-01-01", to: "2025-10-11" });
  assert.deepEqual(compareRange({ from: "2028-02-29", to: "2028-03-05" }, "year"), { from: "2027-02-28", to: "2027-03-05" });
});

const client = (name: string, over: Partial<RangeClient>): RangeClient => ({
  id: name, name, status: "active", signed: null, added: null, churned: null, monthsPaid: null, ...over,
});
const CLIENTS: RangeClient[] = [
  client("Acme", { signed: "2026-02-10", added: "2026-02-14", monthsPaid: 8 }),
  client("Beta", { status: "paused", signed: "2026-05-01", added: "2026-05-03", monthsPaid: 4 }),
  client("Cedar", { status: "churned", signed: "2026-03-01", added: "2026-03-05", churned: "2026-08-20", monthsPaid: 5 }),
  client("Delta", { signed: "2025-11-30", added: "2025-12-02", monthsPaid: 11 }),          // signed last year
  client("Echo", { status: "churned", signed: "2025-06-01", added: "2025-06-03", churned: "2026-01-15", monthsPaid: 7 }),
  client("Fox", { signed: "2026-09-30", added: "2026-10-02" }),                             // on no Stripe subscription
  client("Gamma", { status: "onboarding", signed: "2026-10-05" }),                          // signed, not added yet
  client("Hush", {}),                                                                       // no dates at all
];
const REVENUE: Array<[string, number]> = [["2025-12-20", 900], ["2026-01-01", 100], ["2026-06-15", 2000.5], ["2026-10-11", 400], ["2026-10-12", 9999]];
const YTD = resolveRange("ytd", TODAY, EARLIEST);

test("Signed / Active: who signed in the range, and where those SAME clients stand today", () => {
  const t = rangeTiles(CLIENTS, REVENUE, YTD, compareRange(YTD, "previous"), 1000);
  assert.deepEqual(t.signedNames, ["Acme", "Beta", "Cedar", "Fox", "Gamma"]);
  assert.equal(t.signed, 5);
  assert.equal(t.signedActive, 2, "Acme and Fox");
  assert.equal(t.signedPaused, 1);
  assert.equal(t.signedChurned, 1);
  assert.equal(t.signedOther, 1, "Gamma is still onboarding");
  assert.equal(t.signedActive + t.signedPaused + t.signedChurned + t.signedOther, t.signed, "the split always adds up");
});

test("Clients added and churned in the range — a client churned this year who signed last year still counts as churned", () => {
  const t = rangeTiles(CLIENTS, REVENUE, YTD, compareRange(YTD, "previous"), 1000);
  assert.deepEqual(t.addedNames, ["Acme", "Beta", "Cedar", "Fox"]);
  assert.deepEqual(t.churnedNames, ["Cedar", "Echo"]);
  assert.equal(t.added, 4);
  assert.equal(t.churned, 2);
});

test("Revenue and Growth: collected in the range against the compare period, both ends included", () => {
  const t = rangeTiles(CLIENTS, REVENUE, YTD, compareRange(YTD, "previous"), 1000);
  assert.equal(t.revenue, 2500.5, "1 Jan and today are both in; tomorrow is not");
  assert.equal(t.revenueCompare, 900);
  assert.equal(t.growthPct, Math.round(((2500.5 - 900) / 900) * 1000) / 10);
  assert.equal(sumDays(REVENUE, { from: "2026-10-12", to: "2026-10-12" }), 9999);
});

test("Growth is unknown, not infinite, when the compare period collected nothing", () => {
  const r = { from: "2026-06-01", to: "2026-06-30" };
  const t = rangeTiles(CLIENTS, REVENUE, r, compareRange(r, "previous"), 1000);
  assert.equal(t.revenue, 2000.5);
  assert.equal(t.revenueCompare, 0);
  assert.equal(t.growthPct, null);
});

test("Customer lifespan: the average months paid, across clients signed in the range that Stripe has payments for", () => {
  const t = rangeTiles(CLIENTS, REVENUE, YTD, compareRange(YTD, "previous"), 1000);
  // Acme 8, Beta 4, Cedar 5 — Fox and Gamma signed in range but have no subscription payments.
  assert.equal(t.lifespanClients, 3);
  assert.equal(t.lifespanMonths, 5.7);
});

test("LTV = revenue per account × lifespan, and is unknown when either is", () => {
  const prev = compareRange(YTD, "previous");
  assert.equal(rangeTiles(CLIENTS, REVENUE, YTD, prev, 1328).ltv, Math.round(1328 * 5.7));
  assert.equal(rangeTiles(CLIENTS, REVENUE, YTD, prev, null).ltv, null);
  const nobody = { from: "2024-01-01", to: "2024-01-31" };
  const empty = rangeTiles(CLIENTS, REVENUE, nobody, compareRange(nobody, "previous"), 1328);
  assert.equal(empty.lifespanMonths, null);
  assert.equal(empty.ltv, null);
  assert.equal(empty.signed, 0);
});

test("Stripe unreadable: revenue, growth and LTV are unknown — never zero; the client tiles still count", () => {
  const t = rangeTiles(CLIENTS, null, YTD, compareRange(YTD, "previous"), null);
  assert.equal(t.revenue, null);
  assert.equal(t.revenueCompare, null);
  assert.equal(t.growthPct, null);
  assert.equal(t.ltv, null);
  assert.equal(t.signed, 5);
});

test("average revenue per account is MRR over the active clients", () => {
  assert.equal(revenuePerAccount(37177.23, 28), 1327.76);
  assert.equal(revenuePerAccount(37177.23, 0), null);
  assert.equal(revenuePerAccount(null, 28), null);
});

test("the range reads as the wireframe writes it", () => {
  assert.equal(rangeLabel({ from: "2026-01-01", to: "2026-10-11" }, TODAY), "Jan 1 to Oct 11");
  assert.equal(rangeLabel({ from: "2025-03-04", to: "2026-10-11" }, TODAY), "Mar 4, 2025 to Oct 11, 2026");
  assert.equal(rangeLabel({ from: "2025-01-01", to: "2025-10-11" }, TODAY), "Jan 1, 2025 to Oct 11, 2025");
  assert.equal(rangeLabel({ from: "2026-10-11", to: "2026-10-11" }, TODAY), "Oct 11");
});
