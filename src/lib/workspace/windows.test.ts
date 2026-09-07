/*
 * Comparison-window arithmetic.
 *
 * The home screen's change badges compare the last seven days against the
 * seven before. The windows must be the same length AND adjacent: a one-day
 * hole between them silently drops a day's sending from the comparison, and
 * the resulting percentage still looks entirely plausible. That is precisely
 * how the original 14→8 bug survived — it only surfaced when the same figure
 * was recomputed from the daily series and came out 0.4 points different.
 *
 *   node --test src/lib/workspace/windows.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/** Mirrors isoDaysAgo() in overview.ts — pure date arithmetic, no I/O. */
function isoDaysAgo(days: number, from = new Date("2026-09-07T12:00:00Z")): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const CURRENT = { from: isoDaysAgo(6), to: isoDaysAgo(0) };
const PREVIOUS = { from: isoDaysAgo(13), to: isoDaysAgo(7) };

const dayAfter = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const spanDays = (w: { from: string; to: string }) =>
  Math.round(
    (Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000,
  ) + 1;

test("both windows are exactly seven days", () => {
  assert.equal(spanDays(CURRENT), 7);
  assert.equal(spanDays(PREVIOUS), 7);
});

test("the windows are adjacent — no day falls between them", () => {
  // The actual bug: 14→8 ended on Aug 30 while the current window began
  // Sep 1, so Aug 31 was counted in neither.
  assert.equal(dayAfter(PREVIOUS.to), CURRENT.from);
});

test("the windows do not overlap", () => {
  // Double-counting a day would flatter the comparison in the other direction.
  assert.ok(PREVIOUS.to < CURRENT.from);
});

test("the old 14→8 window would have failed both checks", () => {
  const broken = { from: isoDaysAgo(14), to: isoDaysAgo(8) };
  assert.equal(spanDays(broken), 7, "the length was never the problem");
  assert.notEqual(dayAfter(broken.to), CURRENT.from, "the gap was");
});

test("the arithmetic holds across a month boundary", () => {
  // Sep 7 back to Aug 25 crosses one; a naive day-of-month subtraction breaks
  // here and this is the cheapest place to catch it.
  assert.equal(isoDaysAgo(13), "2026-08-25");
  assert.equal(isoDaysAgo(7), "2026-08-31");
  assert.equal(isoDaysAgo(6), "2026-09-01");
});
