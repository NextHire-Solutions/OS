/*
 * The cron cadence, restated: one run per quarter-hour slot.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/schedule.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SYNC_EVERY_MINUTES, isSyncDue, nextSlotStart, slotKey, syncScheduleEnabled } from "./schedule.ts";

const at = (hh: number, mm: number, ss = 0) => new Date(Date.UTC(2026, 8, 15, hh, mm, ss));

test("the cadence is the tool's */15", () => {
  assert.equal(SYNC_EVERY_MINUTES, 15);
});

test("a fresh install is due immediately", () => {
  assert.equal(isSyncDue(null, at(14, 7)), true);
  assert.equal(isSyncDue("not a date", at(14, 7)), true);
});

test("a run that started in the current slot is not due again until the next slot", () => {
  const started = at(14, 1, 30);
  assert.equal(isSyncDue(started, at(14, 7)), false);
  assert.equal(isSyncDue(started.toISOString(), at(14, 14, 59)), false, "ISO strings too");
  assert.equal(isSyncDue(started, at(14, 15)), true, "the slot boundary is the cron's minute");
});

test("slot arithmetic does not drift with a run's own duration", () => {
  // The cron fired at :00, :15, :30, :45 regardless of how long each run took.
  // A 9-minute run starting at 14:00 must still leave 14:15 due, not 14:24.
  const started = at(14, 0, 40);
  assert.equal(isSyncDue(started, at(14, 15, 10)), true);
  assert.equal(nextSlotStart(started).toISOString(), at(14, 15).toISOString());
  assert.equal(slotKey(at(14, 14, 59)), slotKey(at(14, 0)));
  assert.notEqual(slotKey(at(14, 15)), slotKey(at(14, 0)));
});

test("a manual run satisfies the slot it lands in — one fewer scheduled run, never one more", () => {
  const manual = at(14, 3);
  assert.equal(isSyncDue(manual, at(14, 12)), false);
  assert.equal(isSyncDue(manual, at(14, 16)), true);
});

test("ticking once a minute over a day starts exactly 96 runs", () => {
  // 24h / 15min = 96 slots. A tick every minute, each run "starting" the
  // moment it is due, must fire once per slot: nothing skipped, nothing doubled.
  let last: Date | null = null;
  let runs = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const now = new Date(Date.UTC(2026, 8, 15, 0, m, 20));
    if (isSyncDue(last, now)) { runs++; last = now; }
  }
  assert.equal(runs, 96);
});

test("the schedule is gated on CLIENT_HEALTH_SYNC_ENABLED=1 exactly", () => {
  const env = (map: Record<string, string>) => (k: string) => map[k];
  assert.equal(syncScheduleEnabled(env({})), false);
  assert.equal(syncScheduleEnabled(env({ CLIENT_HEALTH_SYNC_ENABLED: "1" })), true);
  assert.equal(syncScheduleEnabled(env({ CLIENT_HEALTH_SYNC_ENABLED: "true" })), false, "only the documented value");
  assert.equal(syncScheduleEnabled(env({ CLIENT_HEALTH_SYNC_ENABLED: "0" })), false);
});
