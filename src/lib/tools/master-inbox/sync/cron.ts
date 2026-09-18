/*
 * Master Inbox's cron cadence, as data.
 *
 * ---------------------------------------------------------------------------
 * The tool had one scheduled job: POST /api/cron/sync-external-intros, hit by
 * a Railway cron. The schedule itself lived in Railway, not in the repo, so
 * the cadence below is a choice rather than a copy — and it is stated here,
 * once, so it can be corrected in one place if the deployed cron ran on a
 * different interval.
 *
 * 30 minutes: the upstream feed takes ~30 s to answer and each run enriches
 * a small batch of leads at ~1.5 s per Instantly call, so a run is minutes
 * long and there is nothing to gain from overlapping them. Introductions are
 * booked on human timescales; half an hour is well inside what a portal
 * reader would notice.
 *
 * The due logic is the Analytics tool's `dueJobsSince` / `minuteKey`,
 * reused rather than copied: it is the workspace's existing answer to "is it
 * time", already tested, and modulo-based so a process that restarts mid-day
 * resumes the same cadence.
 */

import {
  dueJobsSince,
  minuteKey,
  type ScheduleEntry,
} from "../../analytics/sync/schedule.ts";

export const SYNC_EXTERNAL_INTROS = "sync-external-intros";
/*
 * Releases replies a LIVE off-hours agent drafted inside business hours and
 * held. Runs every five minutes; the sweep re-runs the whole safety gate on
 * each held reply, and while live sending is gated off it finds nothing to
 * send and reports so. Harmless to run early; essential once live is on.
 */
export const RELEASE_HELD_REPLIES = "release-held-replies";

export const SCHEDULE: readonly ScheduleEntry[] = [
  { job: SYNC_EXTERNAL_INTROS, everyMinutes: 30 },
  { job: RELEASE_HELD_REPLIES, everyMinutes: 5 },
];

/** Every job the schedule names, in schedule order. */
export const JOB_NAMES: readonly string[] = SCHEDULE.map((e) => e.job);

/**
 * Which Master Inbox jobs came due in the `windowMinutes` ending now.
 *
 * The window matters for the in-process ticker as much as for a cron
 * container: `setInterval` drifts, and a tick that lands at :30:00.4 after a
 * GC pause must still see the :30 job. Tick every minute with a one-minute
 * window and each scheduled minute falls in exactly one tick.
 */
export function dueMasterInboxJobs(now: Date, windowMinutes = 1): string[] {
  return dueJobsSince(now, windowMinutes, SCHEDULE);
}

export { minuteKey };

/**
 * Whether the in-process scheduler should run in this process.
 *
 * Exactly "1", not truthy: a value like "true" or "yes" was never agreed and
 * silently starting background work on a misread flag is worse than not
 * starting it. The env var is namespaced (MASTER_INBOX_CRON_ENABLED) like
 * every other Master Inbox variable; the caller passes the raw value so this
 * stays pure.
 */
export function cronEnabled(flag: string | undefined): boolean {
  return flag?.trim() === "1";
}
