import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAmountInput, shortAmount, volumeLabel } from "./amount-filter.ts";

test("typed amounts read the way people write them", () => {
  assert.equal(parseAmountInput("3m"), 3_000_000);
  assert.equal(parseAmountInput("$3M"), 3_000_000);
  assert.equal(parseAmountInput(" 3,000,000 "), 3_000_000);
  assert.equal(parseAmountInput("500k"), 500_000);
  assert.equal(parseAmountInput("2.5M"), 2_500_000);
  assert.equal(parseAmountInput("$ 1,250,000"), 1_250_000);
  assert.equal(parseAmountInput(""), null);
  assert.equal(parseAmountInput("   "), null);
  for (const bad of ["three million", "3x", "-5", "1.2.3", "5M-10M"]) assert.equal(parseAmountInput(bad), "invalid", bad);
});

test("short amounts for the button", () => {
  assert.equal(shortAmount(3_000_000), "$3M");
  assert.equal(shortAmount(2_500_000), "$2.5M");
  assert.equal(shortAmount(750_000), "$750K");
  assert.equal(shortAmount(900), "$900");
  assert.equal(shortAmount(1_200_000_000), "$1.2B");
});

test("the control says what is applied", () => {
  assert.equal(volumeLabel(null, null), "Sales volume");
  assert.equal(volumeLabel(3_000_000, null), "Sales volume $3M+");
  assert.equal(volumeLabel(null, 1_000_000), "Sales volume up to $1M");
  assert.equal(volumeLabel(1_000_000, 3_000_000), "Sales volume $1M – $3M");
});
