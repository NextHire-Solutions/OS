import assert from "node:assert/strict";
import { test } from "node:test";
import { validateNewPassword } from "./password.ts";

test("length is the rule", () => {
  assert.equal(validateNewPassword("short", "x"), "Use at least 12 characters.");
  assert.equal(validateNewPassword("twelve chars", "x"), null);
  assert.equal(validateNewPassword("correct horse battery staple", "x"), null, "spaces are fine");
});
test("the same password again is refused", () => {
  assert.match(validateNewPassword("abcd-efgh-jkmn-pqrs", "abcd-efgh-jkmn-pqrs") ?? "", /different/);
});
test("one repeated character is refused", () => {
  assert.match(validateNewPassword("aaaaaaaaaaaaaa", "x") ?? "", /repeated/);
});
test("absurd length is refused", () => {
  assert.match(validateNewPassword("a".repeat(201) + "b", "x") ?? "", /longer/);
});
