/* Who is paying (23 Nov, the team: "No way to see who is paying and who is not"): stripe-summary.ts billingStateOf. */
import { test } from "node:test";
import assert from "node:assert/strict";

const { billingStateOf } = await import("./stripe-summary.ts");
const sub = (status: string, collectionPaused = false) => ({ status, collectionPaused });

test("paying: a subscription collecting (active or trialing, not paused) — even beside an ended one", () => {
  assert.equal(billingStateOf([sub("active")]), "paying");
  assert.equal(billingStateOf([sub("canceled"), sub("active")]), "paying");
  assert.equal(billingStateOf([sub("trialing")]), "paying");
});

test("past due, paused, cancelled, none", () => {
  assert.equal(billingStateOf([sub("past_due")]), "past_due");
  assert.equal(billingStateOf([sub("unpaid")]), "past_due");
  assert.equal(billingStateOf([sub("active", true)]), "paused");
  assert.equal(billingStateOf([sub("past_due", true)]), "paused");
  assert.equal(billingStateOf([sub("canceled"), sub("incomplete_expired")]), "cancelled");
  assert.equal(billingStateOf([]), "none");
});

test("paying wins over a paused or past-due second subscription", () => {
  assert.equal(billingStateOf([sub("active", true), sub("active")]), "paying");
  assert.equal(billingStateOf([sub("past_due"), sub("active")]), "paying");
});
