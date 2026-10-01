import assert from "node:assert/strict";
import { test } from "node:test";

import { canSeePage } from "./nav.ts";

const ALL = ["inbox", "clients", "analytics", "search", "onboarding"] as const;

test("admin-only pages: Team access and Reply agent for admins only; Assistant for admins or anyone holding every tool", () => {
  assert.equal(canSeePage("team-access", false, [...ALL], ALL), false, "every tool is not enough for Team access");
  assert.equal(canSeePage("team-access", true, [], ALL), true);
  assert.equal(canSeePage("reply-agent", false, [...ALL], ALL), false);
  assert.equal(canSeePage("assistant", false, ["inbox"], ALL), false);
  assert.equal(canSeePage("assistant", false, [...ALL], ALL), true);
  assert.equal(canSeePage("assistant", true, [], ALL), true);
  // Consistency became admin-only on 2 Oct (Eddy); the rest stay open to anyone with no sales role.
  for (const id of ["home", "performance", "roster", "commissions"]) {
    assert.equal(canSeePage(id, false, [], ALL), true, `${id} is for everyone signed in`);
  }
});

test("by role (Eddy, 2 Oct): account managers lose Performance and Consistency; salespeople also lose Clients", () => {
  const am = { accountManager: true }, sp = { salesperson: true }, both = { accountManager: true, salesperson: true };
  assert.equal(canSeePage("consistency", false, [...ALL], ALL), false, "Consistency is admin-only now");
  assert.equal(canSeePage("consistency", true, [], ALL), true);
  assert.equal(canSeePage("performance", false, [], ALL, am), false);
  assert.equal(canSeePage("roster", false, [], ALL, am), true);
  assert.equal(canSeePage("commissions", false, [], ALL, am), true);
  assert.equal(canSeePage("performance", false, [], ALL, sp), false);
  assert.equal(canSeePage("roster", false, [], ALL, sp), false);
  assert.equal(canSeePage("commissions", false, [], ALL, sp), true);
  assert.equal(canSeePage("roster", false, [], ALL, both), true, "an account manager who also sells keeps Clients");
  assert.equal(canSeePage("performance", true, [], ALL, both), true, "admins see everything");
  assert.equal(canSeePage("performance", false, [], ALL), true, "no sales role: unchanged");
});
