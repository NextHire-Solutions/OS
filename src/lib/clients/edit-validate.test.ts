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
  // The labels name WHICH person, now that a client can have three of them.
  assert.match(validateEdit({ contactName: "N".repeat(161) })[0] ?? "", /First contact name is 161/);
  assert.match(validateEdit({ contactRole: "R".repeat(121) })[0] ?? "", /First contact's role is 121/);
  assert.match(validateEdit({ contact2Name: "N".repeat(161) })[0] ?? "", /Second contact name is 161/);
  assert.match(validateEdit({ contact3Role: "R".repeat(121) })[0] ?? "", /Third contact's role is 121/);
  assert.match(validateEdit({ brokerage: "B".repeat(161) })[0] ?? "", /Brokerage is 161/);
});

test("every problem is reported at once, not just the first", () => {
  const errs = validateEdit({ contactEmail: "nope", contactName: "N".repeat(200) });
  assert.equal(errs.length, 2);
});

/* =========================================================================
 * §6 / §7: the master record owns the field, so the OS must be able to edit it.
 *
 * Plan, weekly target, start date and billing were already editable from the
 * OS. Monthly target and time zone were not — they could only be changed
 * inside Client Health, which is exactly the "you have to know which tool owns
 * it" problem §4 describes.
 * ========================================================================= */

test("a monthly target must be a whole number of 0 or more", () => {
  assert.deepEqual(validateEdit({ monthlyTarget: 12 }), []);
  assert.deepEqual(validateEdit({ monthlyTarget: 0 }), [], "zero is a real target, not a blank");
  assert.match(validateEdit({ monthlyTarget: -1 })[0] ?? "", /Monthly target/);
  assert.match(validateEdit({ monthlyTarget: 2.5 })[0] ?? "", /whole number/);
});

test("monthly and weekly targets are validated independently", () => {
  // One bad value must not mask the other, or a person fixes one and is told
  // off again for the field they never touched.
  const errors = validateEdit({ weeklyTarget: -1, monthlyTarget: -1 });
  assert.equal(errors.length, 2);
});

test("a time zone is checked against the real zone database, not a pattern", () => {
  for (const tz of ["America/New_York", "America/Los_Angeles", "Europe/London", "UTC", "Asia/Kolkata"]) {
    assert.deepEqual(validateEdit({ timezone: tz }), [], tz);
  }
});

test("a plausible-looking but wrong time zone is rejected", () => {
  // The case a regex would wave through, and the reason this is checked with
  // Intl: a wrong zone never errors at runtime, it just shifts every scheduled
  // send and every "this week" figure by a few hours.
  for (const tz of ["America/New_Yrok", "Americas/New_York", "EST5EDT/nope", "Mars/Olympus"]) {
    const errors = validateEdit({ timezone: tz });
    assert.equal(errors.length, 1, tz);
    assert.match(errors[0], /not a recognised time zone/);
    assert.match(errors[0], /America\/New_York/, "the message shows the shape of a good answer");
  }
});

test("a blank time zone clears the field rather than failing", () => {
  // Same convention as every other nullable field here: "" means clear.
  assert.deepEqual(validateEdit({ timezone: "" }), []);
  assert.deepEqual(validateEdit({ timezone: null }), []);
});

test("the new fields do not disturb the existing ones", () => {
  assert.deepEqual(
    validateEdit({
      plan: "production",
      weeklyTarget: 3,
      monthlyTarget: 12,
      timezone: "America/New_York",
      startDate: "2026-01-05",
      billingInterval: "biweekly",
      billingAnchorDate: "2026-01-05",
    }),
    [],
  );
});
