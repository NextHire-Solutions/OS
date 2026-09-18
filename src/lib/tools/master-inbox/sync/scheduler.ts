import "server-only";

import { env } from "@/lib/tools/master-inbox/env";
import { syncExternalIntros } from "@/lib/tools/master-inbox/portals/external-intros";
import { releaseHeldReplies } from "@/lib/tools/master-inbox/ai/release";
import {
  RELEASE_HELD_REPLIES,
  SYNC_EXTERNAL_INTROS,
  cronEnabled,
  dueMasterInboxJobs,
  minuteKey,
} from "./cron.ts";

/*
 * The in-process scheduler for Master Inbox's one cron job.
 *
 * ---------------------------------------------------------------------------
 * WHY IN-PROCESS, AND WHY IT IS STARTED THE WAY IT IS
 *
 * The tool ran sync-external-intros from a Railway cron hitting its
 * /api/cron route. The workspace has no cron service — the reasoning is set
 * out on src/components/shell/outbox-sweeper.tsx, where the OS's only other
 * recurring job (the introduction outbox sweep) is triggered from whichever
 * browser has the workspace open, every two minutes, against an endpoint
 * that guards itself with a claim.
 *
 * That mechanism is the model here, with one difference forced by the job
 * itself. The sweep is a fast, claim-guarded batch; this sync waits ~30 s on
 * the upstream feed and then throttles Instantly lookups at ~1.5 s each, so
 * a run is minutes long. A browser fetch cannot carry that — the proxy and
 * the browser both give up first — so the browser's role is reduced to the
 * one thing it is good for: proving the server is up and in use. The tick
 * runs HERE, in the Node process, on a `setInterval`.
 *
 * It is the same shape as Client Health's sync/scheduler.ts — a `globalThis`
 * slot, a one-minute `setInterval`, `unref()`, the same "1" gate — and
 * returns the same tri-state, so it can be started from the same place:
 * `src/instrumentation.ts`, next to `ensureClientHealthScheduler()`. That
 * file sits outside the Master Inbox tree and is not edited by this port;
 * until the line is added there, `ensureCronScheduler` is also called from
 * the request handlers the process is guaranteed to serve soon after
 * starting — the two webhook receivers (providers POST continuously), the
 * outbox sweep the browser already drives, and the cron route itself. The
 * first of them to run starts the ticker; the rest are no-ops. Same
 * limitation as the outbox sweeper, stated the same way: a process nobody
 * has touched since boot does nothing until touched.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 *   - Gated on MASTER_INBOX_CRON_ENABLED=1. Unset, this file is inert and an
 *     external cron can still drive /cron/sync-external-intros with the
 *     bearer — the tool's arrangement, unchanged.
 *   - One ticker per process, kept on `globalThis` so a dev-server module
 *     reload does not stack a second interval on the first.
 *   - Modulo due-logic (sync/cron.ts) keyed by minute, so a tick that fires
 *     twice in one minute runs the job once, and a run still in progress
 *     is never overlapped.
 *   - `unref()`, so the interval never holds a shutting-down process open.
 */

const TICK_MS = 60_000;

interface SchedulerState {
  timer: ReturnType<typeof setInterval>;
  lastMinute: number;
  running: Set<string>;
}

const KEY = Symbol.for("brokerstaffer-os.master-inbox.cron");

function state(): SchedulerState | undefined {
  return (globalThis as Record<symbol, unknown>)[KEY] as SchedulerState | undefined;
}

const JOBS: Record<string, () => Promise<unknown>> = {
  [SYNC_EXTERNAL_INTROS]: () => syncExternalIntros(),
  // The workspace is single-tenant; the same id the sync workers use.
  [RELEASE_HELD_REPLIES]: () => releaseHeldReplies(env.WORKSPACE_ID ?? ""),
};

async function tick(s: SchedulerState, now = new Date()): Promise<void> {
  const minute = minuteKey(now);
  if (minute === s.lastMinute) return;
  s.lastMinute = minute;

  for (const job of dueMasterInboxJobs(now, 1)) {
    const run = JOBS[job];
    if (!run || s.running.has(job)) continue;
    s.running.add(job);
    try {
      const result = await run();
      console.log(`[master-inbox cron] ${job}`, JSON.stringify(result));
    } catch (err) {
      console.error(`[master-inbox cron] ${job} failed`, err);
    } finally {
      s.running.delete(job);
    }
  }
}

/**
 * Start the ticker if it is enabled and not already running. Cheap and
 * idempotent — call it from any handler, or once from instrumentation.ts.
 * Same return shape as `ensureClientHealthScheduler`.
 */
export function ensureCronScheduler(): "started" | "already-running" | "disabled" {
  if (state()) return "already-running";
  if (!cronEnabled(env.CRON_ENABLED)) return "disabled";

  const s: SchedulerState = {
    timer: setInterval(() => void tick(s), TICK_MS),
    lastMinute: -1,
    running: new Set(),
  };
  s.timer.unref?.();
  (globalThis as Record<symbol, unknown>)[KEY] = s;
  console.log("[master-inbox cron] in-process scheduler started");
  return "started";
}
