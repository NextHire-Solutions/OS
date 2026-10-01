import assert from "node:assert/strict";
import { test } from "node:test";

import { cents, isEmail, monthlyAmount, normalizeWebUrl } from "./profile-rules.ts";

test("MRR matches Stripe's: $750 every 14 days is $1,630.58 a month", () => {
  assert.equal(cents(monthlyAmount(750, "day", 14)), 1630.58);
  assert.equal(cents(monthlyAmount(1000, "day", 28)), 1087.05);
  assert.equal(monthlyAmount(1500, "month"), 1500);
  assert.equal(monthlyAmount(12000, "year"), 1000);
  assert.equal(cents(monthlyAmount(700, "week", 2)), 1521.88);
});

test("web addresses get https and are checked; blank clears", () => {
  assert.deepEqual(normalizeWebUrl("rafehgroup.com", "Website"), { value: "https://rafehgroup.com" });
  assert.deepEqual(normalizeWebUrl("https://www.zillow.com/profile/rafeh/", "Zillow profile"), { value: "https://www.zillow.com/profile/rafeh/" });
  assert.deepEqual(normalizeWebUrl("  ", "Website"), { value: null });
  assert.ok(normalizeWebUrl("not a site", "Website").error);
  assert.ok(normalizeWebUrl("localhost", "Website").error);
});

test("POC email", () => {
  assert.ok(isEmail("eddy@brokerstaffer.com"));
  assert.ok(!isEmail("eddy@"));
  assert.ok(!isEmail("a@b.com, c@d.com"));
});
