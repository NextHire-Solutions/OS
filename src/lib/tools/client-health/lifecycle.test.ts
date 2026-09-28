/*
 * lifecycleOf — Client Health's status as it is RECORDED, not as the old
 * booleans imply. The booleans cannot say "onboarding"; reading them made every
 * onboarding client appear active on the Clients page, the Consistency screen
 * and the status feed (found 28 Sep with "OpsLabs New").
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { lifecycleOf, statusOf } from "./publish";

test("an onboarding client is onboarding — the case the booleans got wrong", () => {
  const row = { status: "onboarding", hidden: false, client_paused: false };
  assert.equal(lifecycleOf(row), "onboarding");
  assert.equal(statusOf(row), "active"); // what the old derivation said
});

test("the status column wins for every lifecycle value", () => {
  for (const s of ["onboarding", "active", "paused", "churned"] as const) {
    assert.equal(lifecycleOf({ status: s, hidden: false, client_paused: false }), s);
  }
});

test("a row written before migration 0019 (no status) falls back to the booleans", () => {
  assert.equal(lifecycleOf({ hidden: true, client_paused: false }), "churned");
  assert.equal(lifecycleOf({ hidden: false, client_paused: true }), "paused");
  assert.equal(lifecycleOf({ hidden: false, client_paused: false }), "active");
  assert.equal(lifecycleOf({ status: null, hidden: true }), "churned");
});

test("an unrecognised status word is not trusted — the booleans decide", () => {
  assert.equal(lifecycleOf({ status: "prospect", hidden: false, client_paused: true }), "paused");
  assert.equal(lifecycleOf({ status: "", hidden: false, client_paused: false }), "active");
});
