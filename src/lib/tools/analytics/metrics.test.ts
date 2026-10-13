import { test } from "node:test";
import assert from "node:assert/strict";

import { replyRate, replyRatePerContact } from "./metrics.ts";

test("reply rate per contact: the same replies over the people emailed", () => {
  assert.equal(replyRatePerContact(338, 33398), 338 / 33398);
  // Always at least the per-email rate: nobody is emailed less than once.
  assert.ok(replyRatePerContact(338, 33398)! > replyRate(338, 66602)!);
});

test("reply rate per contact: unknown people is a dash, never a number", () => {
  assert.equal(replyRatePerContact(338, null), null);
  assert.equal(replyRatePerContact(338, undefined), null);
  assert.equal(replyRatePerContact(338, 0), null);
  assert.equal(replyRatePerContact(0, 100), 0, "no replies is a real zero");
});
