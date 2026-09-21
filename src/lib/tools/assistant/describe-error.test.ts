import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDbError } from "./describe-error.ts";

/*
 * Pinned because the failure it fixes was invisible. Every tool reported a
 * database error as "[object Object]" — a sentence with no information in it,
 * handed to a model whose job is to explain what went wrong.
 */

test("a PostgREST error becomes the sentence it actually contains", () => {
  // The real shape, from the reminders enum failure.
  const error = {
    code: "22P02",
    details: null,
    hint: null,
    message: 'invalid input value for enum reminder_status: "done"',
  };
  const described = describeDbError(error);
  assert.match(described, /invalid input value for enum reminder_status/);
  assert.match(described, /22P02/);
  assert.doesNotMatch(described, /\[object Object\]/);
});

test("details and hint are kept — they are usually the actionable half", () => {
  const described = describeDbError({
    message: "column x does not exist",
    details: "in table y",
    hint: "did you mean z",
    code: "42703",
  });
  assert.match(described, /column x does not exist/);
  assert.match(described, /in table y/);
  assert.match(described, /did you mean z/);
});

test("an Error, a string and null each read sensibly", () => {
  assert.equal(describeDbError(new Error("boom")), "boom");
  assert.equal(describeDbError("boom"), "boom");
  assert.equal(describeDbError(null), "unknown error");
});

test("an object with no message still says something", () => {
  const described = describeDbError({ weird: true });
  assert.doesNotMatch(described, /\[object Object\]/);
  assert.match(described, /weird/);
});
