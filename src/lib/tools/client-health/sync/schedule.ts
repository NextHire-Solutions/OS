import { optionalEnv } from "@/lib/env";

/*
 * The cadence the tool's sync-worker ran on, as data.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TOOL DID
 *
 * A second Railway service, `sync-worker`, with start command
 * `npx tsx scripts/sync.ts` and Cron Schedule `*​/15 * * * *` (README, "Deploy on
 * Railway" — the schedule is set in the Railway dashboard, not in the repo, so
 * README is the only written record of it). Every quarter hour Railway booted a
 * one-shot container, ran the sync once, and exited. No lock, no due check;
 * the cadence WAS the schedule.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD
 *
 * The workspace has no cron service — see outbox-sweeper.tsx for why adding
 * one is not free — so the cadence is reproduced in-process: a browser tab on a
 * Client Health screen ticks POST /api/tools/client-health/sync/tick roughly
 * once a minute, and the SERVER decides whether a run is due. The decision is
 * the cron's, restated: the tool fired once per quarter-hour slot, so a run is
 * due when no run has STARTED in the current slot. Slot arithmetic rather than
 * "15 minutes since the last run" so the cadence does not drift later with
 * every run's own duration, exactly as a cron does not.
 *
 * `sync_runs.started_at` is what the sync already writes, per source, at the
 * start of every run — manual or scheduled — so it is the record consulted.
 * A manual press therefore also satisfies the slot it lands in: one fewer
 * scheduled run, never one more, and never two at once.
 */

/** The tool's Railway cron: `*​/15 * * * *`. */
export const SYNC_EVERY_MINUTES = 15;

/** The browser's polling interval. Bounds how late into a slot a run starts. */
export const TICK_EVERY_MS = 60 * 1000;

/**
 * The quarter-hour slot an instant falls in. Two instants in the same slot
 * share a key; the cron would have fired once for them.
 */
export function slotKey(at: Date, everyMinutes: number = SYNC_EVERY_MINUTES): number {
  return Math.floor(at.getTime() / (everyMinutes * 60_000));
}

/** Start of the slot after the one `at` falls in — when the next run comes due. */
export function nextSlotStart(at: Date, everyMinutes: number = SYNC_EVERY_MINUTES): Date {
  return new Date((slotKey(at, everyMinutes) + 1) * everyMinutes * 60_000);
}

/**
 * Whether the scheduled tick should start a run now.
 *
 * Due when nothing has started in the current slot. `lastStartedAt` is the
 * newest `sync_runs.started_at`, or null when the table is empty — a fresh
 * install is due immediately, as the first cron tick would have been.
 */
export function isSyncDue(
  lastStartedAt: Date | string | null,
  now: Date,
  everyMinutes: number = SYNC_EVERY_MINUTES,
): boolean {
  if (!lastStartedAt) return true;
  const last = lastStartedAt instanceof Date ? lastStartedAt : new Date(lastStartedAt);
  if (!Number.isFinite(last.getTime())) return true;
  return slotKey(last, everyMinutes) < slotKey(now, everyMinutes);
}

/**
 * The gate. CLIENT_HEALTH_SYNC_ENABLED=1 turns the in-process schedule on;
 * anything else leaves the tick a no-op. Off by default so a preview or a
 * local checkout with production credentials never starts writing on its
 * own — the same reason the tool's cron was a separate, deliberately
 * deployed service.
 */
export function syncScheduleEnabled(env: (name: string) => string | undefined = optionalEnv): boolean {
  return env("CLIENT_HEALTH_SYNC_ENABLED") === "1";
}
