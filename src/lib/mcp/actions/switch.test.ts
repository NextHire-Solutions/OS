import { test } from "node:test";
import assert from "node:assert/strict";

import { enabledActions } from "./switch.ts";

test("no OS_MCP_ACTIONS: no actions; each switched on by name; unknown names ignored", () => {
  assert.equal(enabledActions({}).size, 0);
  assert.equal(enabledActions({ OS_MCP_ACTIONS: "" }).size, 0);
  assert.deepEqual([...enabledActions({ OS_MCP_ACTIONS: " inbox_snooze , nope,CLIENT_CAMPAIGNS" })].sort(), ["client_campaigns", "inbox_snooze"]);
});
