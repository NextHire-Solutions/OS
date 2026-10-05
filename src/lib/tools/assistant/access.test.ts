import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_TOOLS, type SsoSession } from "../../bs-auth.ts";
import { canUseAssistant } from "./access.ts";

const session = (email: string | null, grants: string[] = []): SsoSession | null =>
  email ? ({ email, grants, ver: 1, iat: 0, exp: Date.now() + 60_000 } as unknown as SsoSession) : null;

test("the assistant is for admins only (5 Oct) — holding every tool is not enough", () => {
  assert.equal(canUseAssistant(null, true), false);
  assert.equal(canUseAssistant(session("member@example.com", [...ALL_TOOLS]), false), false);
  assert.equal(canUseAssistant(session("member@example.com", ["inbox"]), false), false);
  assert.equal(canUseAssistant(session("admin@example.com", []), true), true);
});
