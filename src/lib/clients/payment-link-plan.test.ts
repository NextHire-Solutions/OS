import assert from "node:assert/strict";
import { test } from "node:test";

import { canCreate, describe, parseAmount, parseEvery, recurringParams } from "./payment-link-plan.ts";

test("amounts are dollars as people type them, never zero, never absurd", () => {
  assert.deepEqual(parseAmount("750"), { cents: 75000 });
  assert.deepEqual(parseAmount("$1,500.50"), { cents: 150050 });
  assert.deepEqual(parseAmount(250), { cents: 25000 });
  for (const bad of ["", "0", "-5", "abc", "12.345", "100001"]) assert.ok("error" in parseAmount(bad), bad);
});

test("the three frequencies map to Stripe's recurring prices exactly", () => {
  assert.deepEqual(recurringParams("14 days"), { "recurring[interval]": "day", "recurring[interval_count]": "14" });
  assert.deepEqual(recurringParams("28 days"), { "recurring[interval]": "day", "recurring[interval_count]": "28" });
  assert.deepEqual(recurringParams("month"), { "recurring[interval]": "month", "recurring[interval_count]": "1" });
  assert.equal(parseEvery("weekly"), null);
  assert.equal(describe(75000, "14 days"), "$750 every 14 days");
});

test("a new subscription only for a client with none, or whose one has ended", () => {
  assert.equal(canCreate(null), true);
  assert.equal(canCreate({ status: "canceled" }), true);
  assert.equal(canCreate({ status: "active" }), false, "never a second live subscription by accident");
  assert.equal(canCreate({ status: "past_due" }), false);
});
