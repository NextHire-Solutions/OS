import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_TOOLS } from "../bs-auth.ts";
import { canSeePage, PAGE_GRANTS } from "./nav.ts";

const EVERY = [...ALL_TOOLS];
const ROLES = [{}, { accountManager: true }, { salesperson: true }, { accountManager: true, salesperson: true }];

test("admin-only pages: Team access, Reply agent, Consistency, Assistant — even with every switch and every role", () => {
  for (const id of ["team-access", "reply-agent", "consistency", "assistant"]) {
    for (const roles of ROLES) {
      assert.equal(canSeePage(id, false, EVERY, ALL_TOOLS, roles), false, `${id}: a teammate with every switch, roles ${JSON.stringify(roles)}`);
    }
    assert.equal(canSeePage(id, true, [], ALL_TOOLS), true, `${id}: admin`);
  }
});

test("Clients, Commissions and Performance (with its Billing Calendar) follow their own switch (15 Oct)", () => {
  assert.deepEqual({ ...PAGE_GRANTS }, { roster: "roster", commissions: "commissions", performance: "performance", "billing-calendar": "performance" });
  for (const [page, grant] of Object.entries(PAGE_GRANTS)) {
    assert.equal(canSeePage(page, false, [grant], ALL_TOOLS), true, `${page}: its switch on`);
    const others = EVERY.filter((g) => g !== grant);
    assert.equal(canSeePage(page, false, others, ALL_TOOLS), false, `${page}: every switch but its own`);
    assert.equal(canSeePage(page, true, [], ALL_TOOLS), true, `${page}: admins always`);
  }
});

test("a role alone no longer opens a page — Eddy chooses who sees what on Team access", () => {
  for (const roles of ROLES) {
    assert.equal(canSeePage("roster", false, [], ALL_TOOLS, roles), false, `Clients without its switch, roles ${JSON.stringify(roles)}`);
    assert.equal(canSeePage("commissions", false, [], ALL_TOOLS, roles), false, `Commissions without its switch, roles ${JSON.stringify(roles)}`);
  }
});

test("Home is for everyone, switched on or not", () => {
  for (const roles of ROLES) {
    assert.equal(canSeePage("home", false, [], ALL_TOOLS, roles), true);
  }
});
