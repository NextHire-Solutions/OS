import assert from "node:assert/strict";
import { test } from "node:test";

import { applyRange, modeFor, rangeIds, shiftClick } from "./range-select.ts";

const ids = [10, 11, 12, 13, 14, 15];
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

test("a run is inclusive and works in either direction", () => {
  assert.deepEqual(rangeIds(ids, 1, 3), [11, 12, 13]);
  assert.deepEqual(rangeIds(ids, 3, 1), [11, 12, 13]);
  assert.deepEqual(rangeIds(ids, 2, 2), [12]);
  assert.deepEqual(rangeIds(ids, -5, 99), ids);
});

test("dragging from an unticked row ticks the run and keeps everything else", () => {
  const base = new Set([15]);
  assert.equal(modeFor(base, 10), "select");
  assert.deepEqual(sorted(applyRange(base, ids, 0, 2, "select")), [10, 11, 12, 15]);
  assert.deepEqual(sorted(base), [15], "the starting selection is never changed in place");
});

test("dragging from a ticked row unticks the run", () => {
  const base = new Set([10, 11, 12, 13]);
  assert.equal(modeFor(base, 11), "deselect");
  assert.deepEqual(sorted(applyRange(base, ids, 1, 2, "deselect")), [10, 13]);
});

test("Shift-click ticks everything between the last click and this one", () => {
  // Clicked row 1 (ticked it), then Shift-clicked row 4.
  assert.deepEqual(sorted(shiftClick(new Set([11]), ids, 1, 4)), [11, 12, 13, 14]);
  // Upwards works too.
  assert.deepEqual(sorted(shiftClick(new Set([14]), ids, 4, 0)), [10, 11, 12, 13, 14]);
});

test("Shift-click on a ticked row unticks the run", () => {
  assert.deepEqual(sorted(shiftClick(new Set([10, 11, 12, 13, 14]), ids, 1, 3)), [10, 14]);
});
