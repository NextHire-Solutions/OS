/*
 * One sync at a time.
 *
 * ---------------------------------------------------------------------------
 * WHY A LOCK, AND WHY THIS ONE
 *
 * In the tool the sync had two entry points that could overlap — the Railway
 * cron container and the dashboard's ↻ button — and nothing stopped them.
 * runBison does a read-modify-write on weekly_metrics (it ADDS to the Instantly
 * subtotal runInstantly just wrote), so two interleaved runs can double-count a
 * week. It was tolerable there because the cron was a separate process nobody
 * pressed the button during. Here the button, the scheduled tick and a future
 * external cron all land on the same process, so overlap is the normal case
 * unless something refuses it.
 *
 * The lock is in-process: a single Railway instance runs this app, and the
 * scheduled tick additionally checks `sync_runs` before starting (see
 * schedule.ts), which is what keeps a second instance honest if one ever
 * exists. A database lock row would be the next step; it is not one the tool
 * had, so it is not invented here.
 *
 * A held lock that is never released would stop every sync until a deploy, so
 * the holder is a promise and the lock frees itself when it settles — there is
 * no `release()` to forget.
 */

export interface SyncLockState {
  /** True while a run holds the lock. */
  running: boolean;
  /** When the current run started, or null. */
  startedAt: Date | null;
  /** Who started it — "manual" (the button), "scheduled" (the tick), "secret" (an external caller). */
  reason: string | null;
}

let holder: { startedAt: Date; reason: string; promise: Promise<unknown> } | null = null;

/**
 * Runs `work` under the lock, or returns null WITHOUT running it when another
 * run holds the lock. The caller decides what "busy" means to it.
 */
export function withSyncLock<T>(
  reason: string,
  work: () => Promise<T>,
  now: () => Date = () => new Date(),
): Promise<T> | null {
  if (holder) return null;
  const promise = work().finally(() => {
    // Only the run that took the lock may drop it.
    if (holder?.promise === promise) holder = null;
  });
  holder = { startedAt: now(), reason, promise };
  return promise;
}

export function syncLockState(): SyncLockState {
  return holder
    ? { running: true, startedAt: holder.startedAt, reason: holder.reason }
    : { running: false, startedAt: null, reason: null };
}

/** Test seam. Never called by the app. */
export function _resetSyncLockForTests(): void {
  holder = null;
}
