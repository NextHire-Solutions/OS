import { test } from "node:test";
import assert from "node:assert/strict";

import { isPreSplitSession, preSplitPageGrants, preSplitToolGrants, sessionPageGrants, SWITCH_SPLIT_AT } from "./switch-transition.ts";

/*
 * Sessions signed before the 15 Oct switch split keep what they had until they
 * renew; sessions signed after it get exactly their switches.
 */

const BEFORE = SWITCH_SPLIT_AT - 60_000;
const AFTER = SWITCH_SPLIT_AT + 60_000;

test("the cut-off is after the deploy (15 Oct 2026, 17:00 UTC) and splits sessions at it", () => {
  assert.equal(new Date(SWITCH_SPLIT_AT).toISOString(), "2026-10-15T17:00:00.000Z");
  assert.equal(isPreSplitSession(BEFORE), true);
  assert.equal(isPreSplitSession(AFTER), false);
  assert.equal(isPreSplitSession(Number.NaN), false);
});

test("before: the Campaign Analytics switch still opens Campaign Management and Inboxes", () => {
  assert.deepEqual(preSplitToolGrants(["inbox", "analytics"], BEFORE), ["inbox", "analytics", "campaigns", "inboxes"]);
  assert.deepEqual(preSplitToolGrants(["inbox"], BEFORE), ["inbox"], "no analytics, nothing added");
});

test("after: exactly the switches — Campaign Analytics opens only itself", () => {
  assert.deepEqual(preSplitToolGrants(["inbox", "analytics"], AFTER), ["inbox", "analytics"]);
});

test("before: the Account manager role still opens Clients and Commissions, a salesperson's Commissions", () => {
  assert.deepEqual(preSplitPageGrants(["inbox"], true, { accountManager: true }), ["inbox", "roster", "commissions"]);
  assert.deepEqual(preSplitPageGrants(["inbox"], true, { salesperson: true }), ["inbox", "commissions"]);
  assert.deepEqual(preSplitPageGrants(["inbox"], true, {}), ["inbox"]);
});

test("after: roles open nothing", () => {
  assert.deepEqual(preSplitPageGrants(["inbox"], false, { accountManager: true, salesperson: true }), ["inbox"]);
});

test("never Performance, never an admin page, whatever the session's age", () => {
  for (const at of [BEFORE, AFTER]) {
    const g = sessionPageGrants({ grants: ["inbox", "portals", "clients", "analytics", "search", "onboarding"], iat: at }, { accountManager: true, salesperson: true });
    assert.equal(g.includes("performance"), false, String(at));
  }
});

test("Amy, mid-session at the deploy, keeps every page she had", () => {
  const amy = sessionPageGrants({ grants: ["inbox", "clients", "analytics", "onboarding"], iat: BEFORE }, { accountManager: true });
  for (const g of ["inbox", "clients", "analytics", "campaigns", "inboxes", "roster", "commissions"]) assert.ok(amy.includes(g as never), g);
});
