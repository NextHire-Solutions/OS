import { test } from "node:test";
import assert from "node:assert/strict";

import { codesToColumn, columnToCodes, deriveCodes, seedFromCodes, type Board } from "./markets-mls";

const BOARDS: Board[] = [
  { code: "GLVAR", name: "Greater Las Vegas AOR", state: "NV" },
  { code: "MLSPIN", name: "MLS Property Information Network", state: "MA" },
  { code: "Stellar", name: "Stellar MLS", state: "FL" },
];

test("codes come from the markets, in the board's own spelling, once each", () => {
  const d = deriveCodes(
    [{ market: "Las Vegas", mls: "glvar" }, { market: "Henderson", mls: "GLVAR" }, { market: "Tampa", mls: " stellar " }],
    BOARDS,
  );
  assert.deepEqual(d, { codes: ["GLVAR", "Stellar"], unknown: [] });
});

test("a market with no MLS contributes nothing", () => {
  assert.deepEqual(deriveCodes([{ market: "Boston", mls: null }, { market: "X", mls: "  " }], BOARDS), { codes: [], unknown: [] });
});

test("an MLS matching no board is reported, never sent to the lead builder", () => {
  const d = deriveCodes([{ market: "Boston", mls: "MLS PIN" }, { market: "B2", mls: "mls pin" }, { market: "Vegas", mls: "GLVAR" }], BOARDS);
  assert.deepEqual(d.codes, ["GLVAR"]);
  assert.deepEqual(d.unknown, ["MLS PIN"]);
});

test("the column round-trips in the format the Onboarding page has always written", () => {
  assert.equal(codesToColumn(["GLVAR", "Stellar"]), "GLVAR, Stellar");
  assert.equal(codesToColumn([]), null);
  assert.deepEqual(columnToCodes("GLVAR, Stellar"), ["GLVAR", "Stellar"]);
  assert.deepEqual(columnToCodes(null), []);
  assert.deepEqual(columnToCodes(" , "), []);
});

test("intake codes seed markets named after their board", () => {
  assert.deepEqual(seedFromCodes(["glvar", "MLSPIN"], BOARDS), [
    { market: "Greater Las Vegas AOR", mls: "GLVAR", area: null },
    { market: "MLS Property Information Network", mls: "MLSPIN", area: null },
  ]);
});

test("an intake code the Database has no board for is kept as typed", () => {
  assert.deepEqual(seedFromCodes(["HAR"], BOARDS), [{ market: "HAR", mls: "HAR", area: null }]);
});

test("seeding never creates the same board twice", () => {
  assert.equal(seedFromCodes(["GLVAR", "glvar", " GLVAR "], BOARDS).length, 1);
});
