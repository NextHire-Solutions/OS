import { test } from "node:test";
import assert from "node:assert/strict";

import { NO_RANGES, RANGE_COLUMNS, filterByRanges, parseBound, rangeChipLabel, rangesActive } from "./inbox-ranges.ts";

const row = (over: Partial<Record<string, number | null>> = {}) => ({
  dailyLimit: 25, sentAllTime: 1000, repliedAllTime: 10, bouncedAllTime: 2, warmup3d: 100 as number | null, warmup7d: 95 as number | null, ...over,
});
const with_ = (over: Partial<typeof NO_RANGES>) => ({ ...NO_RANGES, ...over });

test("a bound is a typed number; nothing or nonsense is no bound, never zero", () => {
  assert.equal(parseBound("25"), 25);
  assert.equal(parseBound(" 1,200 "), 1200);
  assert.equal(parseBound("0"), 0);
  assert.equal(parseBound("99.5"), 99.5);
  for (const t of ["", "  ", "abc", "1-2", "1e3", ","]) assert.equal(parseBound(t), null, JSON.stringify(t));
});

test("no bounds: every row, the very same list", () => {
  const rows = [row(), row({ dailyLimit: null })];
  assert.equal(filterByRanges(rows, NO_RANGES), rows);
  assert.equal(rangesActive(NO_RANGES), 0);
});

test("lowest, highest, and both — inclusive at each end", () => {
  const rows = [row({ dailyLimit: 5 }), row({ dailyLimit: 20 }), row({ dailyLimit: 25 }), row({ dailyLimit: 50 })];
  const limits = (r: typeof NO_RANGES) => filterByRanges(rows, r).map((x) => x.dailyLimit);
  assert.deepEqual(limits(with_({ dailyLimit: { min: "20", max: "" } })), [20, 25, 50]);
  assert.deepEqual(limits(with_({ dailyLimit: { min: "", max: "20" } })), [5, 20]);
  assert.deepEqual(limits(with_({ dailyLimit: { min: "20", max: "25" } })), [20, 25]);
});

test("bounds typed the wrong way round are read the way they were meant", () => {
  const rows = [row({ dailyLimit: 5 }), row({ dailyLimit: 20 }), row({ dailyLimit: 50 })];
  assert.deepEqual(filterByRanges(rows, with_({ dailyLimit: { min: "30", max: "10" } })).map((x) => x.dailyLimit), [20]);
});

test("an inbox with no value fails a bound on that column — a dash is not a low score", () => {
  const rows = [row({ warmup3d: null }), row({ warmup3d: 40 }), row({ warmup3d: 100 })];
  assert.deepEqual(filterByRanges(rows, with_({ warmup3d: { min: "", max: "50" } })).map((x) => x.warmup3d), [40]);
  assert.deepEqual(filterByRanges(rows, with_({ warmup3d: { min: "0", max: "" } })).map((x) => x.warmup3d), [40, 100]);
});

test("bounds on several columns must all hold", () => {
  const rows = [row({ sentAllTime: 10, bouncedAllTime: 0 }), row({ sentAllTime: 5000, bouncedAllTime: 0 }), row({ sentAllTime: 5000, bouncedAllTime: 90 })];
  const out = filterByRanges(rows, with_({ sent: { min: "1000", max: "" }, bounced: { min: "", max: "5" } }));
  assert.deepEqual(out.map((x) => [x.sentAllTime, x.bouncedAllTime]), [[5000, 0]]);
});

test("every number column reads its own value", () => {
  const r = row({ dailyLimit: 1, sentAllTime: 2, repliedAllTime: 3, bouncedAllTime: 4, warmup3d: 5, warmup7d: 6 });
  RANGE_COLUMNS.forEach(({ key }, i) => {
    const exact = String(i + 1);
    assert.equal(filterByRanges([r], with_({ [key]: { min: exact, max: exact } })).length, 1, key);
    assert.equal(filterByRanges([r], with_({ [key]: { min: String(i + 2), max: "" } })).length, 0, key);
  });
});

test("a half-typed bound filters nothing", () => {
  const rows = [row()];
  assert.equal(filterByRanges(rows, with_({ sent: { min: "abc", max: "" } })).length, 1);
  assert.equal(rangesActive(with_({ sent: { min: "abc", max: "" } })), 0);
});

test("the chip says how many number filters are on", () => {
  assert.equal(rangeChipLabel(NO_RANGES), "Numbers");
  assert.equal(rangeChipLabel(with_({ warmup7d: { min: "90", max: "" } })), "Numbers: Warmup (7 days)");
  assert.equal(rangeChipLabel(with_({ warmup7d: { min: "90", max: "" }, dailyLimit: { min: "", max: "20" } })), "Numbers: 2");
  assert.equal(rangesActive(with_({ warmup7d: { min: "90", max: "" }, dailyLimit: { min: "", max: "20" } })), 2);
});
