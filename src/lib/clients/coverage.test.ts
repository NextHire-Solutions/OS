import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanCoverage, cleanList, coverageLine, hasCoverage } from "./coverage.ts";

test("the sheet's shape is kept as it is — 6 markets, 7 areas, 5 boards, no pairing", () => {
  const { value, problems } = cleanCoverage({
    markets: "6",
    mls: "CANOPY, realMLS, GGAR, CHMLS, CMLS",
    areas: "Jacksonville, Charleston, Columbia, Greenville, Savannah, Atlanta, Charlotte",
  });
  assert.deepEqual(problems, []);
  assert.equal(value.markets, 6);
  assert.equal(value.mls!.length, 5);
  assert.equal(value.areas!.length, 7);
});

test("lists are tidied: trimmed, blanks and repeats (any case) dropped, order kept", () => {
  assert.deepEqual(cleanList(" FTL ,, nant, FTL, MLSPIN "), ["FTL", "nant", "MLSPIN"]);
  assert.deepEqual(cleanList(["Boston", "boston", " South  Florida "]), ["Boston", "South Florida"]);
  assert.deepEqual(cleanList(null), []);
});

test("markets must be a whole number; blank clears it; only the keys sent change", () => {
  assert.equal(cleanCoverage({ markets: "2.5" }).problems.length, 1);
  assert.equal(cleanCoverage({ markets: -1 }).problems.length, 1);
  assert.deepEqual(cleanCoverage({ markets: "" }).value, { markets: null });
  assert.deepEqual(Object.keys(cleanCoverage({ areas: "Austin" }).value), ["areas"]);
});

test("one line for the Database and Onboarding screens", () => {
  assert.equal(coverageLine({ markets: 1, mls: ["BRIGHT", "CVR"], areas: ["greater Richmond"] }), "BRIGHT, CVR · greater Richmond");
  assert.equal(coverageLine({ markets: 1, mls: [], areas: ["Cincinnati-Dayton"] }), "Cincinnati-Dayton");
  assert.equal(coverageLine({ markets: null, mls: [], areas: [] }), null);
  assert.equal(hasCoverage({ markets: 1, mls: [], areas: [] }), true);
});
