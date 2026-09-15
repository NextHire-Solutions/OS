import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WINDOW_MINUTES,
  createTicker,
  dueForTick,
  ensureScheduler,
  schedulerEnabled,
  stopScheduler,
  windowMinutes,
} from "./scheduler.ts";
import { minuteKey } from "./schedule.ts";
import type { RunOutcome } from "./runner.ts";

const at = (hhmmss: string) => new Date(`2026-09-15T${hhmmss}Z`);

test("environment: enabled only by the literal 1; window defaults and floors", () => {
  assert.equal(schedulerEnabled({ ANALYTICS_ENABLE_SCHEDULER: "1" }), true);
  assert.equal(schedulerEnabled({ ANALYTICS_ENABLE_SCHEDULER: "true" }), false);
  assert.equal(schedulerEnabled({}), false);

  assert.equal(windowMinutes({}), DEFAULT_WINDOW_MINUTES);
  assert.equal(windowMinutes({ ANALYTICS_CRON_WINDOW_MINUTES: "10" }), 10);
  assert.equal(windowMinutes({ ANALYTICS_CRON_WINDOW_MINUTES: "2.9" }), 2);
  assert.equal(windowMinutes({ ANALYTICS_CRON_WINDOW_MINUTES: "0" }), DEFAULT_WINDOW_MINUTES);
  assert.equal(windowMinutes({ ANALYTICS_CRON_WINDOW_MINUTES: "soon" }), DEFAULT_WINDOW_MINUTES);
});

test("a fresh process replays the window, so a boot after :00 still fires the daily job", () => {
  const { due, minute } = dueForTick(at("06:03:40"), null, 10);
  assert.ok(due.includes("sync-steps"), "06:00 daily");
  assert.ok(due.includes("sync-replies"), "06:00 is a 10-minute boundary");
  assert.ok(due.includes("sync-entities"), "06:00 is a 30-minute boundary");
  assert.ok(!due.includes("sync-leads"), "05:00 is outside the window");
  assert.equal(minute, minuteKey(at("06:03:40")));
});

test("the second visit to a minute fires nothing and keeps the cursor", () => {
  const first = dueForTick(at("06:10:05"), minuteKey(at("06:09:35")), 10);
  assert.deepEqual(first.due, ["sync-replies"]);
  const second = dueForTick(at("06:10:35"), first.minute, 10);
  assert.deepEqual(second.due, []);
  assert.equal(second.minute, first.minute);
});

test("a normal tick covers exactly one minute", () => {
  const { due } = dueForTick(at("06:01:10"), minuteKey(at("06:00:40")), 10);
  assert.deepEqual(due, []);
});

test("a paused process catches up the minutes it missed, capped at the window", () => {
  // Three minutes missed: 06:00 came due in the gap and is recovered.
  const caught = dueForTick(at("06:02:10"), minuteKey(at("05:59:40")), 10);
  assert.ok(caught.due.includes("sync-steps"));

  // An hour missed with a 10-minute window: only 06:51..07:00 is replayed —
  // 07:00's daily-series-deep fires, 06:00's sync-steps does not.
  const capped = dueForTick(at("07:00:20"), minuteKey(at("05:59:40")), 10);
  assert.ok(capped.due.includes("sync-daily-series-deep"));
  assert.ok(!capped.due.includes("sync-steps"));
});

test("window 1 is the tool's exact-minute ticker", () => {
  const { due } = dueForTick(at("06:03:40"), null, 1);
  assert.deepEqual(due, []);
});

test("the ticker starts each due job once, in the background, and never throws", async () => {
  const started: string[] = [];
  const logged: string[] = [];
  const run = async (job: string): Promise<RunOutcome> => {
    started.push(job);
    if (job === "sync-replies") throw new Error("boom");
    return { job, status: "ok", durationMs: 5, rowsWritten: 1 };
  };
  const ticker = createTicker({
    run,
    known: (job) => job !== "sync-entities",
    windowMinutes: 1,
    log: (line) => logged.push(line),
  });

  const fired = ticker.tick(at("06:30:10"));
  // 06:30: replies (10), entities (30), reply-labels (30), instantly-leads (30),
  // instantly-replies (30), the two backfills (30). Entities is "unknown" here.
  assert.ok(fired.includes("sync-replies"));
  assert.ok(!fired.includes("sync-entities"), "unregistered names are skipped");
  assert.deepEqual(fired, started, "every fired job was handed to run()");

  assert.deepEqual(ticker.tick(at("06:30:40")), [], "same minute, second visit");

  await new Promise((r) => setImmediate(r));
  assert.ok(logged.some((l) => l.startsWith("[cron] sync-reply-labels ok in 5ms (1 rows)")));
});

test("ensureScheduler starts once per process and honours the switch", () => {
  try {
    assert.equal(ensureScheduler({}), "disabled");
    assert.equal(ensureScheduler({ ANALYTICS_ENABLE_SCHEDULER: "1", NEXT_RUNTIME: "edge" }), "disabled");
    assert.equal(ensureScheduler({ ANALYTICS_ENABLE_SCHEDULER: "1" }), "started");
    assert.equal(ensureScheduler({ ANALYTICS_ENABLE_SCHEDULER: "1" }), "already-running");
  } finally {
    stopScheduler();
  }
});
