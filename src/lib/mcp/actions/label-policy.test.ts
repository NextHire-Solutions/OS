import { test } from "node:test";
import assert from "node:assert/strict";

import { labelPolicy } from "./label-policy.ts";

test("allowed: labels that change nothing outside the OS", () => {
  for (const l of ["Not Interested", "Keep Warm", "OOO", "Objection", "Not Qualified", "Wrong Person", "Not Right Now", "Broker/Owner"]) {
    assert.deepEqual(labelPolicy("Interested", l), { ok: true }, l);
    assert.deepEqual(labelPolicy(null, l), { ok: true }, l);
  }
});

test("refused: Interested, Introduction and every stop label; and relabelling an Introduction", () => {
  for (const l of ["Interested", "interested ", "Meetings Booked", "Introduction", "Hostile", "Unsubscribe", "Do Not Contact", "Add to Blocklist"]) {
    const r = labelPolicy("OOO", l);
    assert.equal(r.ok, false, l);
  }
  const intro = labelPolicy("Introduction", "Keep Warm");
  assert.equal(intro.ok, false);
  assert.match((intro as { reason: string }).reason, /portal entry/);
  assert.match((labelPolicy("Keep Warm", "keep warm") as { reason: string }).reason, /already/);
});

test("refused: any change to a conversation ever marked Interested or Meetings Booked (it can move a per-lead bill)", () => {
  for (const l of ["Not Interested", "Not Qualified", "Broker/Owner", "Keep Warm", "OOO"]) {
    const r = labelPolicy("Not Interested", l, true);
    assert.equal(r.ok, false, l);
  }
  assert.match((labelPolicy("Keep Warm", "OOO", true) as { reason: string }).reason, /billed/);
});
