import { test } from "node:test";
import assert from "node:assert/strict";

import { canRenewStatus, statusRefusal, statusRefusalShort } from "./status.ts";

test("running, paused and finished campaigns can be renewed (any case)", () => {
  for (const s of ["active", "paused", "completed", " Active "]) {
    assert.equal(canRenewStatus(s), true, s);
    assert.equal(statusRefusal(s), null);
    assert.equal(statusRefusalShort(s), null);
  }
});

test("a draft, an archived or an unknown campaign is refused with its reason", () => {
  assert.match(statusRefusal("draft") ?? "", /draft: it has not started/);
  assert.match(statusRefusalShort("Draft") ?? "", /^A draft has not started/);
  assert.match(statusRefusal("archived") ?? "", /This campaign is archived\. Only a running, paused or finished campaign/);
  assert.match(statusRefusalShort("pending deletion") ?? "", /is pending deletion cannot be renewed/);
  assert.match(statusRefusal(null) ?? "", /in an unknown state/);
  assert.equal(canRenewStatus(undefined), false);
});
