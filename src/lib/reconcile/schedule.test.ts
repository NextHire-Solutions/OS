import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_HOUR_UTC,
  daySlot,
  hourUtc,
  isReconcileDue,
  reconcileScheduleEnabled,
  reconcileSendEnabled,
} from "./schedule";

/*
 * The clock §16 was missing. These tests pin the two properties that decide
 * whether this is an improvement or a nuisance: it fires ONCE a day, and it is
 * silent until somebody turns it on.
 *
 * The most important test is the last one — sending is a separate switch from
 * running. Turning the clock on must not start messaging a channel, because the
 * route is deliberately report-only by default and a scheduler that quietly
 * undid that would be worse than no scheduler.
 */

const at = (iso: string): Date => new Date(iso);
const env = (vars: Record<string, string>) => (name: string) => vars[name];

test("a process that has never run it is due once the hour arrives", () => {
  assert.equal(isReconcileDue(null, at("2026-09-25T13:00:00Z"), 13), true);
  assert.equal(isReconcileDue(null, at("2026-09-25T23:59:00Z"), 13), true);
});

test("before the hour, nothing is due — not even a fresh process", () => {
  assert.equal(isReconcileDue(null, at("2026-09-25T12:59:00Z"), 13), false);
  assert.equal(isReconcileDue(null, at("2026-09-25T00:00:00Z"), 13), false);
});

test("having run today, it is not due again today", () => {
  const ranToday = at("2026-09-25T13:00:00Z");
  assert.equal(isReconcileDue(ranToday, at("2026-09-25T13:05:00Z"), 13), false);
  assert.equal(isReconcileDue(ranToday, at("2026-09-25T22:00:00Z"), 13), false);
});

test("it comes due again the next day, at the hour and not before", () => {
  const ranYesterday = at("2026-09-24T13:00:00Z");
  assert.equal(isReconcileDue(ranYesterday, at("2026-09-25T12:00:00Z"), 13), false);
  assert.equal(isReconcileDue(ranYesterday, at("2026-09-25T13:00:00Z"), 13), true);
});

test("a run late in the day still satisfies that day", () => {
  // The bounded duplicate this module documents: a deploy at 23:50 runs, and
  // the next day's slot is a fresh one. What must NOT happen is a second run
  // ten minutes later at 00:00 feeling "due" because 24h had not passed.
  const ranLate = at("2026-09-25T23:50:00Z");
  assert.equal(isReconcileDue(ranLate, at("2026-09-25T23:55:00Z"), 13), false);
  assert.equal(isReconcileDue(ranLate, at("2026-09-26T13:00:00Z"), 13), true);
});

test("an unparseable last-run time is treated as never run, not as now", () => {
  // Failing this way round matters: the alternative silently stops the check
  // forever, which is the exact failure this module exists to fix.
  assert.equal(isReconcileDue("not a date", at("2026-09-25T13:00:00Z"), 13), true);
});

test("a string timestamp is accepted, as a stored value would be", () => {
  assert.equal(isReconcileDue("2026-09-25T13:00:00.000Z", at("2026-09-25T18:00:00Z"), 13), false);
  assert.equal(isReconcileDue("2026-09-24T13:00:00.000Z", at("2026-09-25T18:00:00Z"), 13), true);
});

test("day slots are UTC days, so two instants in one day share a key", () => {
  assert.equal(daySlot(at("2026-09-25T00:00:00Z")), daySlot(at("2026-09-25T23:59:59Z")));
  assert.notEqual(daySlot(at("2026-09-25T23:59:59Z")), daySlot(at("2026-09-26T00:00:00Z")));
});

test("the hour is read from the environment, and a bad value falls back", () => {
  assert.equal(hourUtc(env({ OS_RECONCILE_ALERT_HOUR_UTC: "6" })), 6);
  assert.equal(hourUtc(env({ OS_RECONCILE_ALERT_HOUR_UTC: "0" })), 0);
  assert.equal(hourUtc(env({ OS_RECONCILE_ALERT_HOUR_UTC: "23" })), 23);
  assert.equal(hourUtc(env({})), DEFAULT_HOUR_UTC);
  for (const bad of ["24", "-1", "13.5", "noon", "", " "]) {
    assert.equal(hourUtc(env({ OS_RECONCILE_ALERT_HOUR_UTC: bad })), DEFAULT_HOUR_UTC, bad);
  }
  // Number() accepts exponent notation, so "1e1" is the hour 10. Left working
  // rather than rejected: it is a valid way to write a number, and the fallback
  // is for values that are not numbers at all.
  assert.equal(hourUtc(env({ OS_RECONCILE_ALERT_HOUR_UTC: "1e1" })), 10);
});

test("the schedule is off unless it is turned on with exactly 1", () => {
  assert.equal(reconcileScheduleEnabled(env({})), false);
  assert.equal(reconcileScheduleEnabled(env({ OS_RECONCILE_ALERT_ENABLED: "1" })), true);
  for (const v of ["0", "true", "yes", "", "on"]) {
    assert.equal(reconcileScheduleEnabled(env({ OS_RECONCILE_ALERT_ENABLED: v })), false, v);
  }
});

test("running the check and sending it are separate switches", () => {
  // Enabling the clock must never imply permission to post to a channel.
  const clockOnly = env({ OS_RECONCILE_ALERT_ENABLED: "1" });
  assert.equal(reconcileScheduleEnabled(clockOnly), true);
  assert.equal(reconcileSendEnabled(clockOnly), false);

  const both = env({ OS_RECONCILE_ALERT_ENABLED: "1", OS_RECONCILE_ALERT_SEND: "1" });
  assert.equal(reconcileSendEnabled(both), true);
});
