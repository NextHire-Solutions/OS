import assert from "node:assert/strict";
import { test } from "node:test";

import { canUseAssistant } from "./access.ts";
import { ALL_TOOLS } from "@/lib/bs-auth";

const session = (email: string | null, grants: string[] = []) =>
  (email === null ? null : { email, grants, ver: 0, iat: 0, exp: 0 }) as never;

/*
 * The assistant answers across every client's numbers, so partial access must
 * not become full access by asking a chat window instead of opening a screen.
 */

test("nobody signed out", () => {
  assert.equal(canUseAssistant(null), false);
  assert.equal(canUseAssistant(session(null)), false);
});

test("a person with only some tools is refused", () => {
  assert.equal(canUseAssistant(session("member@example.com", ["inbox"])), false);
  assert.equal(
    canUseAssistant(session("member@example.com", ALL_TOOLS.slice(0, -1) as unknown as string[])),
    false,
    "one tool short is still short",
  );
});

test("a person holding every tool is allowed", () => {
  assert.equal(canUseAssistant(session("member@example.com", [...ALL_TOOLS])), true);
});

test("a grant that is not a real tool does not count towards 'all'", () => {
  assert.equal(canUseAssistant(session("member@example.com", ["inbox", "not-a-tool", "clients"])), false);
});
