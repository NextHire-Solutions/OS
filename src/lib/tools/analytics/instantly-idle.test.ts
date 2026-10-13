/*
 * "Metrics not showing" (13 Oct): Positive, Positive Rate, Lead to Email and
 * Bounces were a dash whenever Instantly was merely not filtered OUT — even
 * with nothing sent on it. Idle means idle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { instantlyIdle, mergedBounces, mergedPositive } from "./instantly-idle.ts";

const idle = { sent: 0, replies: 0, human_replies: 0, bounces: null };
const busy = { sent: 2063, replies: 12, human_replies: 9, bounces: null };

test("no sends and no replies in the window is idle; anything at all is not", () => {
  assert.equal(instantlyIdle(idle), true);
  assert.equal(instantlyIdle(null), true);
  assert.equal(instantlyIdle(undefined), true);
  assert.equal(instantlyIdle({ sent: null, replies: null, human_replies: null }), true);
  assert.equal(instantlyIdle(busy), false);
  assert.equal(instantlyIdle({ sent: 0, replies: 1, human_replies: 0 }), false, "a late reply to an old campaign still counts");
  assert.equal(instantlyIdle({ sent: 1, replies: 0, human_replies: 0 }), false);
});

test("Positive: EmailBison's figure when Instantly was idle — the whole, not a half", () => {
  assert.equal(mergedPositive(41, idle), 41);
  assert.equal(mergedPositive(0, idle), 0, "a real zero stays a zero");
  assert.equal(mergedPositive(41, null), 41);
});

test("Positive: still unknown the moment Instantly did anything", () => {
  assert.equal(mergedPositive(41, busy), null);
  assert.equal(mergedPositive(41, { sent: 0, replies: 3, human_replies: 0 }), null);
});

test("Positive: unknown stays unknown", () => {
  assert.equal(mergedPositive(null, idle), null);
  assert.equal(mergedPositive(undefined, idle), null);
});

test("Bounces: summed where Instantly reports them, as before", () => {
  assert.equal(mergedBounces(30, { ...busy, bounces: 4 }), 34);
  assert.equal(mergedBounces(30, { ...idle, bounces: 0 }), 30);
  assert.equal(mergedBounces(null, { ...busy, bounces: 4 }), 4);
});

test("Bounces: EmailBison's alone when Instantly sent nothing and so has no figure", () => {
  assert.equal(mergedBounces(30, idle), 30);
});

test("Bounces: unknown when Instantly sent but cannot say how many bounced", () => {
  assert.equal(mergedBounces(30, busy), null);
});
