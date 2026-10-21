import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_TOOLS } from "../bs-auth.ts";
import { canSeePage, PAGE_GRANTS } from "./nav.ts";
import { holdsPage, NAMED_PAGES, namedPagesFor } from "../identity/named-pages.ts";

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

test("admin-only pages opened by name: the Reply agent to Amy (21 Oct) — that page only, and nobody else", () => {
  assert.deepEqual(NAMED_PAGES, { "reply-agent": ["amy@brokerstaffer.com"] }, "a person is added here deliberately, on the user's word");
  assert.deepEqual(namedPagesFor(" Amy@BrokerStaffer.com "), ["reply-agent"]);
  const amy = { pages: namedPagesFor("amy@brokerstaffer.com") };
  assert.equal(canSeePage("reply-agent", false, [], ALL_TOOLS, amy), true);
  for (const id of ["team-access", "consistency", "assistant"]) assert.equal(canSeePage(id, false, EVERY, ALL_TOOLS, amy), false, `${id}: not opened by the Reply agent`);
  for (const email of ["amy@brokerstaffer.co", "amy.anderes@brokerstaffer.com", "eddy@brokerstaffer.com", "gabriel@brokerstaffer.com", "", null]) {
    assert.deepEqual(namedPagesFor(email), [], String(email));
    assert.equal(holdsPage(email, "reply-agent"), false, String(email));
    assert.equal(canSeePage("reply-agent", false, EVERY, ALL_TOOLS, { pages: namedPagesFor(email) }), false, String(email));
  }
});

test("the Reply agent page's routes accept the same people — and its other admin routes do not change", async () => {
  const fs = await import("node:fs");
  const read = (p: string) => fs.readFileSync(p, "utf8");
  for (const f of ["reply-agents/route.ts", "reply-agents/[id]/route.ts", "reply-agents/[id]/duplicate/route.ts"]) {
    const src = read(`src/app/api/tools/master-inbox/${f}`);
    assert.doesNotMatch(src, /requireAdminSession/, f);
    assert.match(src, /requireReplyAgentSession\(\)/, f);
  }
  for (const f of ["corpus", "feedback", "knowledge", "proposals"]) {
    const src = read(`src/app/api/tools/master-inbox/ai/${f}/route.ts`);
    assert.match(src, /canUseReplyAgent\(session\.email\)/, f);
    assert.doesNotMatch(src, /isAdminUser/, f);
  }
  // Running the agent by hand and releasing held replies stay admins-only.
  for (const f of ["reply-agents/run/route.ts", "reply-agents/release/route.ts"]) assert.match(read(`src/app/api/tools/master-inbox/${f}`), /requireAdminSession\(\)/, f);
});
