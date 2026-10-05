import assert from "node:assert/strict";
import { test } from "node:test";

import { canSeePage } from "./nav.ts";

const ALL = ["inbox", "clients", "analytics", "search", "onboarding"] as const;

test("admin-only pages (5 Oct): Team access, Reply agent, Consistency, Performance, Assistant — even with every tool", () => {
  for (const id of ["team-access", "reply-agent", "consistency", "performance", "assistant"]) {
    assert.equal(canSeePage(id, false, [...ALL], ALL), false, `${id}: a teammate with every tool`);
    assert.equal(canSeePage(id, false, [...ALL], ALL, { accountManager: true, salesperson: true }), false, `${id}: account manager + salesperson`);
    assert.equal(canSeePage(id, true, [], ALL), true, `${id}: admin`);
  }
});

test("by role: Clients for account managers, Commissions for account managers and salespeople, Home for everyone", () => {
  const am = { accountManager: true }, sp = { salesperson: true }, none = {};
  assert.equal(canSeePage("roster", false, [], ALL, am), true);
  assert.equal(canSeePage("roster", false, [], ALL, sp), false);
  assert.equal(canSeePage("roster", false, [...ALL], ALL, none), false, "a teammate with no role does not see Clients");
  assert.equal(canSeePage("commissions", false, [], ALL, am), true);
  assert.equal(canSeePage("commissions", false, [], ALL, sp), true);
  assert.equal(canSeePage("commissions", false, [...ALL], ALL, none), false, "no role, no payouts to show");
  for (const r of [am, sp, none]) assert.equal(canSeePage("home", false, [], ALL, r), true);
  assert.equal(canSeePage("roster", true, [], ALL, none), true, "admins see everything");
});
