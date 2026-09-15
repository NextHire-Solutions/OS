/*
 * The secret path fails CLOSED.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/auth.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { secretMatches } from "./auth.ts";

test("an unset secret never matches — not even an empty supplied one", () => {
  assert.equal(secretMatches("", undefined), false);
  assert.equal(secretMatches("anything", undefined), false);
  assert.equal(secretMatches(null, undefined), false);
});

test("a configured secret matches exactly, and nothing else", () => {
  assert.equal(secretMatches("s3cret", "s3cret"), true);
  assert.equal(secretMatches("s3cre", "s3cret"), false);
  assert.equal(secretMatches("s3cret ", "s3cret"), false);
  assert.equal(secretMatches("", "s3cret"), false);
  assert.equal(secretMatches(undefined, "s3cret"), false);
});
