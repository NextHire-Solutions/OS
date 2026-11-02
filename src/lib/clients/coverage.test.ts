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

test("MLS: at most 40 — BrokerStaffer's own record lists every MLS it recruits in (3 Nov); Area keeps 40 for it too", async () => {
  const { MAX_ITEMS, MAX_ITEMS_HOUSE } = await import("./coverage.ts");
  const codes = Array.from({ length: 55 }, (_, i) => `MLS${i}`);
  assert.deepEqual(cleanCoverage({ mls: codes }).problems, [`MLS can list at most ${MAX_ITEMS}.`]);
  const house = cleanCoverage({ mls: codes }, { house: true });
  assert.deepEqual(house.problems, []);
  assert.equal(house.value.mls?.length, 55);
  assert.deepEqual(cleanCoverage({ mls: Array.from({ length: MAX_ITEMS_HOUSE + 1 }, (_, i) => `M${i}`) }, { house: true }).problems, [`MLS can list at most ${MAX_ITEMS_HOUSE}.`]);
  assert.deepEqual(cleanCoverage({ areas: codes }, { house: true }).problems, [`Area can list at most ${MAX_ITEMS}.`]);
});
