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
  for (const id of ["home", "performance", "roster", "consistency", "commissions"]) {
    assert.equal(canSeePage(id, false, [], ALL), true, `${id} is for everyone signed in`);
  }
});
