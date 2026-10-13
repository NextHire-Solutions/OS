/*
 * "Wagner says Billing in 2 days, but on the Client it's a different date."
 * The cases below are the estate on 13 Oct 2026, by name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { alignWithStripe, alignmentNote, nextOnCadence, recordStepDays, stripeAnchor, type ScheduleOnRecord, type StripeSubscriptionFact } from "./billing-align.ts";

const TODAY = "2026-10-13";
const rec = (over: Partial<ScheduleOnRecord> = {}): ScheduleOnRecord => ({
  billing_anchor_date: null, start_date: "2026-08-18", billing_interval: "biweekly", billing_interval_days: null, ...over,
});
const sub = (nextCharge: string | null, stepDays: number | null = 14, state: "active" | "paused" = "active"): StripeSubscriptionFact => ({ state, stepDays, nextCharge });

test("the record's cycle in days", () => {
  assert.equal(recordStepDays(rec()), 14);
  assert.equal(recordStepDays(rec({ billing_interval: "28-days" })), 28);
  assert.equal(recordStepDays(rec({ billing_interval: "custom", billing_interval_days: 21 })), 21);
  assert.equal(recordStepDays(rec({ billing_interval: "custom", billing_interval_days: null })), null);
  assert.equal(recordStepDays(rec({ billing_interval: "monthly" })), null);
});

test("next date on a cadence: on or after today, from an anchor in the past or the future", () => {
  assert.equal(nextOnCadence("2026-08-18", 14, TODAY), "2026-10-13", "today is a cycle day");
  assert.equal(nextOnCadence("2026-08-18", 14, "2026-10-11"), "2026-10-13");
  assert.equal(nextOnCadence("2026-08-18", 14, "2026-10-14"), "2026-10-27");
  assert.equal(nextOnCadence("2026-10-23", 14, TODAY), "2026-10-23", "a future anchor is itself the next date");
  assert.equal(nextOnCadence("2026-11-20", 14, TODAY), "2026-10-23", "…or steps back to the first one not yet past");
});

test("Wagner: no anchor, cycle from the start date says 13 Oct; Stripe charges 23 Oct — follow Stripe", () => {
  const a = alignWithStripe(rec(), [sub("2026-10-23")], TODAY);
  assert.deepEqual(a, { kind: "follow", anchor: "2026-10-23", stripeNext: "2026-10-23", recordNext: "2026-10-13" });
  assert.equal(stripeAnchor(a), "2026-10-23");
  assert.deepEqual(alignmentNote(a), { tone: "info", text: "Following Stripe's charge date. The dates on the client's record gave Oct 13." });
});

test("Jeff Cook and SERHANT NJ: an anchor a few days off Stripe — follow Stripe", () => {
  const jeff = alignWithStripe(rec({ billing_anchor_date: "2026-08-25", start_date: "2026-05-04" }), [sub("2026-10-16")], TODAY);
  assert.equal(jeff.kind, "follow");
  assert.equal(jeff.kind === "follow" && jeff.recordNext, "2026-10-20");
  const serhant = alignWithStripe(rec({ billing_anchor_date: "2026-06-26", start_date: "2026-04-13" }), [sub("2026-10-19")], TODAY);
  assert.equal(stripeAnchor(serhant), "2026-10-19");
});

test("the 18 that already agree are left exactly alone", () => {
  // 54 Realty: anchor 17 Sep, Stripe 15 Oct — 28 days on, the same cycle.
  const a = alignWithStripe(rec({ billing_anchor_date: "2026-09-17", start_date: "2026-03-03" }), [sub("2026-10-15")], TODAY);
  assert.deepEqual(a, { kind: "aligned", stripeNext: "2026-10-15" });
  assert.equal(stripeAnchor(a), null, "no anchor is substituted");
  assert.equal(alignmentNote(a), null);
  // The Toll Group: no anchor at all, but its start date happens to be on Stripe's cycle.
  assert.equal(alignWithStripe(rec({ start_date: "2026-09-21" }), [sub("2026-10-19")], TODAY).kind, "aligned");
});

test("Rise: the record says every 28 days, Stripe charges every 14 — reported, never moved", () => {
  const a = alignWithStripe(rec({ billing_interval: "28-days", billing_anchor_date: "2026-08-14", start_date: "2026-07-07" }), [sub("2026-10-23", 14)], TODAY);
  assert.deepEqual(a, { kind: "differs", reason: "interval", stripeNext: "2026-10-23", stripeStep: 14, recordStep: 28, recordNext: "2026-11-06" });
  assert.equal(stripeAnchor(a), null);
  assert.match(alignmentNote(a)!.text, /^Stripe charges every 14 days \(next Oct 23\), but the client's record says every 28 days\./);
  assert.equal(alignmentNote(a)!.tone, "warn");
});

test("a 28-day record whose Stripe charge lands on its cycle agrees, whatever Stripe's own interval", () => {
  const a = alignWithStripe(rec({ billing_interval: "28-days", billing_anchor_date: "2026-07-29" }), [sub("2026-10-21", 28)], TODAY);
  assert.equal(a.kind, "aligned");
});

test("no Stripe subscription, a paused one, or one with no date: the record is all there is", () => {
  assert.deepEqual(alignWithStripe(rec(), [], TODAY), { kind: "none" });
  assert.deepEqual(alignWithStripe(rec(), [sub(null, 14, "paused")], TODAY), { kind: "none" });
  assert.deepEqual(alignWithStripe(rec(), [sub("2026-10-23", 14, "paused")], TODAY), { kind: "none" }, "a paused subscription charges nobody");
  assert.deepEqual(alignWithStripe(rec(), [sub("not a date")], TODAY), { kind: "none" });
  assert.equal(alignmentNote({ kind: "none" }), null);
});

test("two subscriptions on the same cycle: one cadence, followed from the nearer charge", () => {
  const a = alignWithStripe(rec(), [sub("2026-11-06"), sub("2026-10-23")], TODAY);
  assert.deepEqual(a, { kind: "follow", anchor: "2026-10-23", stripeNext: "2026-10-23", recordNext: "2026-10-13" });
});

test("two subscriptions on different days: no single cycle to follow — said, not guessed", () => {
  const a = alignWithStripe(rec(), [sub("2026-10-23"), sub("2026-10-29")], TODAY);
  assert.equal(a.kind, "differs");
  assert.equal(a.kind === "differs" && a.reason, "several");
  assert.equal(stripeAnchor(a), null);
});

test("two subscriptions, one of them on the record's cycle: they agree", () => {
  const a = alignWithStripe(rec({ billing_anchor_date: "2026-09-17" }), [sub("2026-10-23"), sub("2026-10-15")], TODAY);
  assert.deepEqual(a, { kind: "aligned", stripeNext: "2026-10-15" });
});

test("a monthly record is never re-anchored", () => {
  const monthly = rec({ billing_interval: "monthly", billing_anchor_date: "2026-08-23" });
  assert.equal(alignWithStripe(monthly, [sub("2026-10-23", null)], TODAY).kind, "aligned", "same day of the month");
  const off = alignWithStripe(monthly, [sub("2026-10-28", null)], TODAY);
  assert.equal(off.kind === "differs" && off.reason, "monthly");
  const days = alignWithStripe(monthly, [sub("2026-10-23", 14)], TODAY);
  assert.equal(days.kind === "differs" && days.reason, "interval");
  assert.equal(stripeAnchor(off), null);
  assert.equal(stripeAnchor(days), null);
});

test("a record with no dates at all still follows a matching Stripe cadence", () => {
  const a = alignWithStripe(rec({ start_date: null }), [sub("2026-10-23")], TODAY);
  assert.deepEqual(a, { kind: "follow", anchor: "2026-10-23", stripeNext: "2026-10-23", recordNext: null });
  assert.deepEqual(alignmentNote(a), { tone: "info", text: "Following Stripe's charge date." });
});

test("timestamps are read as their day", () => {
  const a = alignWithStripe(rec({ billing_anchor_date: "2026-09-17T00:00:00+00:00" }), [sub("2026-10-15T04:00:00Z")], TODAY);
  assert.equal(a.kind, "aligned");
});
