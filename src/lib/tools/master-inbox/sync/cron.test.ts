/*
 * Master Inbox's cron cadence and the gate on the in-process scheduler.
 *
 *   node --test src/lib/tools/master-inbox/sync/cron.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { JOB_NAMES, RELEASE_HELD_REPLIES, SCHEDULE, SYNC_EXTERNAL_INTROS, cronEnabled, dueMasterInboxJobs, minuteKey } from "./cron.ts";

const at = (hh: number, mm: number, ss = 0) => new Date(Date.UTC(2026, 8, 15, hh, mm, ss));

test("the two jobs scheduled here are the tool's sync and the reply agent's release sweep", () => {
  // The release sweep was added with the client-approved reply agent
  // upgrade: it re-checks replies a live off-hours agent held inside
  // business hours. While live sending is gated off it finds nothing.
  assert.deepEqual(JOB_NAMES, [SYNC_EXTERNAL_INTROS, RELEASE_HELD_REPLIES]);
  for (const entry of SCHEDULE) {
    const hasInterval = entry.everyMinutes !== undefined;
    const hasDaily = entry.dailyAtUtcHour !== undefined;
    assert.ok(hasInterval !== hasDaily, `${entry.job} must have exactly one cadence`);
  }
});

test("the intro sync is due on the half hour; the release sweep every five minutes", () => {
  assert.deepEqual(dueMasterInboxJobs(at(14, 0)), [SYNC_EXTERNAL_INTROS, RELEASE_HELD_REPLIES]);
  assert.deepEqual(dueMasterInboxJobs(at(14, 30)), [SYNC_EXTERNAL_INTROS, RELEASE_HELD_REPLIES]);
  assert.deepEqual(dueMasterInboxJobs(at(14, 5)), [RELEASE_HELD_REPLIES]);
  assert.deepEqual(dueMasterInboxJobs(at(14, 7)), []);
  assert.deepEqual(dueMasterInboxJobs(at(14, 29)), []);
  assert.deepEqual(dueMasterInboxJobs(at(14, 31)), []);
});

test("a late tick still sees the job within its window", () => {
  // setInterval drifts; a tick evaluated at :30:00.4 must match :30.
  assert.deepEqual(dueMasterInboxJobs(at(14, 30, 40)), [SYNC_EXTERNAL_INTROS, RELEASE_HELD_REPLIES]);
  // And a tick a minute late catches it only if told to look back.
  assert.deepEqual(dueMasterInboxJobs(at(14, 31), 1), []);
  assert.deepEqual(dueMasterInboxJobs(at(14, 31), 2), [SYNC_EXTERNAL_INTROS, RELEASE_HELD_REPLIES]);
});

test("one-minute windows tile the day: 48 intro syncs and 288 release sweeps, none doubled", () => {
  const runs: Record<string, number> = { [SYNC_EXTERNAL_INTROS]: 0, [RELEASE_HELD_REPLIES]: 0 };
  for (let minute = 0; minute < 24 * 60; minute++) {
    for (const job of dueMasterInboxJobs(new Date(Date.UTC(2026, 8, 15, 0, 0) + minute * 60_000), 1)) runs[job]++;
  }
  assert.equal(runs[SYNC_EXTERNAL_INTROS], 48);
  assert.equal(runs[RELEASE_HELD_REPLIES], 288);
});

test("ticks are keyed by minute so a doubled tick runs once", () => {
  assert.equal(minuteKey(at(14, 30, 1)), minuteKey(at(14, 30, 59)));
  assert.notEqual(minuteKey(at(14, 30)), minuteKey(at(14, 31)));
});

test("the scheduler gate is exactly \"1\"", () => {
  assert.equal(cronEnabled("1"), true);
  assert.equal(cronEnabled(" 1 "), true);
  for (const off of [undefined, "", "0", "true", "yes", "on", "11"]) {
    assert.equal(cronEnabled(off), false, `${JSON.stringify(off)} must not enable the scheduler`);
  }
});
