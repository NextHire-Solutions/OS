import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEdit } from "./edit.ts";

test("introduction fields are optional, and blank means clear", () => {
  assert.deepEqual(validateEdit({}), []);
  assert.deepEqual(validateEdit({ contactName: "", contactRole: "", contactEmail: "", brokerage: "" }), []);
});

test("a contact email has to be an address", () => {
  assert.deepEqual(validateEdit({ contactEmail: "nicole@oz.com" }), []);
  assert.match(validateEdit({ contactEmail: "nicole" })[0] ?? "", /valid email/);
  assert.match(validateEdit({ contactEmail: "a b@c.com" })[0] ?? "", /valid email/);
});

test("the lengths match what the introduction template can hold", () => {
  assert.deepEqual(validateEdit({ contactName: "N".repeat(160) }), []);
  assert.match(validateEdit({ contactName: "N".repeat(161) })[0] ?? "", /Contact name is 161/);
  assert.match(validateEdit({ contactRole: "R".repeat(121) })[0] ?? "", /Their role is 121/);
  assert.match(validateEdit({ brokerage: "B".repeat(161) })[0] ?? "", /Brokerage is 161/);
});

test("every problem is reported at once, not just the first", () => {
  const errs = validateEdit({ contactEmail: "nope", contactName: "N".repeat(200) });
  assert.equal(errs.length, 2);
});
