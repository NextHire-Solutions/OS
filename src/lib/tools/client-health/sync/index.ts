import "server-only";

import { withSyncLock, syncLockState } from "./lock";
import { runSync, type SyncResult } from "./runSync";
import { getWeekly } from "../weekly";

/*
 * The one way in. Both routes — the button's POST /sync and the schedule's
 * POST /sync/tick — come through here, so the lock and the cache invalidation
 * cannot be forgotten by one of them.
 *
 * After a run the workspace's cached copy of the dashboard is dropped: the sync
 * just rewrote weekly_metrics and the client counters, and serving the previous
 * minute's numbers for up to sixty more seconds would make a successful sync
 * read as one that did nothing. Invalidated on failure too — a run that got
 * through Instantly and failed on Corofy still wrote the Instantly half.
 */

export type { SyncResult } from "./runSync";

export type TriggerOutcome =
  | { started: true; result: Promise<SyncResult> }
  | { started: false; busySince: Date | null };

export function triggerSync(reason: "manual" | "scheduled" | "secret"): TriggerOutcome {
  const run = withSyncLock(reason, async () => {
    try {
      return await runSync();
    } finally {
      getWeekly.invalidate();
    }
  });
  if (!run) return { started: false, busySince: syncLockState().startedAt };
  return { started: true, result: run };
}

export { syncLockState } from "./lock";
export { syncHealth, summarizeRuns, type SyncHealth } from "./health";
export { isSyncDue, nextSlotStart, syncScheduleEnabled, SYNC_EVERY_MINUTES, TICK_EVERY_MS } from "./schedule";
