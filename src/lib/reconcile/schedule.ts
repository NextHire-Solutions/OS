import { optionalEnv } from "@/lib/env";

/*
 * When the drift check runs, as data.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * §16 asks for two things, and the wording is specific about the second:
 *
 *   "We need to know IMMEDIATELY that there is a synchronization problem."
 *   "We should not have to discover these issues manually."
 *
 * `/api/cron/reconcile-alert` answers the first. It answered the second only on
 * paper: its own comment says "schedule it like the other crons", and nothing
 * ever did. The route was referenced in exactly two places in the repo — the
 * proxy's auth table and itself — so the checks ran only when a person called
 * them by hand, which is the manual discovery the section rules out.
 *
 * This is the missing clock. The OS has no cron service (see instrumentation.ts),
 * so the cadence runs in-process like every other absorbed schedule.
 *
 * ---------------------------------------------------------------------------
 * DAILY, AT A FIXED HOUR
 *
 * The route's comment already argued the cadence and this honours it: "DAILY,
 * not every ten minutes. Every finding here is a state that persists until a
 * person fixes it, so a short interval would repeat the same message all day
 * and get the channel muted."
 *
 * A fixed hour rather than "24h since the last run" so the time of day does not
 * walk forward by each run's own duration, and so the report lands before
 * people start work rather than at whatever hour the last deploy happened.
 *
 * ---------------------------------------------------------------------------
 * ONE KNOWN LIMIT, DELIBERATELY ACCEPTED
 *
 * The last-run time lives in the process, not in a table: the OS has no
 * settings store, and adding a table to a live database to hold one timestamp
 * is a worse trade than the failure it prevents. The failure is bounded — a
 * deploy DURING the scheduled hour can run the check twice in one day, which
 * costs one extra read of four databases and, once sending is on, one repeated
 * message. Deploys outside that hour cost nothing, because the new process sees
 * an hour that has already passed for today and waits for tomorrow's slot.
 */

/** Ticks are cheap — a date compare — so they can be frequent. */
export const TICK_EVERY_MS = 5 * 60 * 1000;

/** The hour used when OS_RECONCILE_ALERT_HOUR_UTC is unset or unusable. */
export const DEFAULT_HOUR_UTC = 13;

/**
 * The UTC day an instant falls in. Two instants in the same day share a key,
 * and the check fires once per key.
 */
export function daySlot(at: Date): number {
  return Math.floor(at.getTime() / 86_400_000);
}

/**
 * The hour to run at, in UTC.
 *
 * Anything that is not an integer 0–23 falls back to the default rather than
 * throwing: a typo in a variable must not stop the check from ever running,
 * which is the failure this whole module exists to fix.
 *
 * Blank is treated as absent HERE rather than relying on the reader to do it.
 * `optionalEnv` does trim and return undefined, so passing the real reader is
 * safe either way — but `Number("")` is 0, a perfectly valid hour, so a reader
 * that returned the raw value would silently move the run to midnight. Deciding
 * it in one place is the point; a rule spelled twice is how these drift.
 */
export function hourUtc(env: (name: string) => string | undefined = optionalEnv): number {
  const raw = env("OS_RECONCILE_ALERT_HOUR_UTC");
  if (raw === undefined || raw.trim() === "") return DEFAULT_HOUR_UTC;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) return DEFAULT_HOUR_UTC;
  return n;
}

/**
 * Whether the check should run now.
 *
 * Due when the day's hour has arrived and nothing has run in this UTC day.
 * `lastRanAt` null means this process has not run it yet, so a boot after the
 * hour runs once and then waits for tomorrow — the same thing a cron container
 * booting late would have done.
 */
export function isReconcileDue(
  lastRanAt: Date | string | null,
  now: Date,
  hour: number = DEFAULT_HOUR_UTC,
): boolean {
  if (now.getUTCHours() < hour) return false;
  if (!lastRanAt) return true;
  const last = lastRanAt instanceof Date ? lastRanAt : new Date(lastRanAt);
  if (!Number.isFinite(last.getTime())) return true;
  return daySlot(last) < daySlot(now);
}

/**
 * The gate. Off unless OS_RECONCILE_ALERT_ENABLED=1, for the reason every other
 * scheduler here is off by default: a preview deployment or a local checkout
 * holding production credentials must not start reading four databases and
 * posting to a channel on its own.
 */
export function reconcileScheduleEnabled(
  env: (name: string) => string | undefined = optionalEnv,
): boolean {
  return env("OS_RECONCILE_ALERT_ENABLED") === "1";
}

/**
 * Whether the scheduled run may POST to Slack.
 *
 * A second switch, and separate on purpose: the route is report-only without
 * `?send=1` so a schedule can be pointed at it and read before anyone wires up
 * a channel. Turning the clock on must not silently start messaging people.
 */
export function reconcileSendEnabled(
  env: (name: string) => string | undefined = optionalEnv,
): boolean {
  return env("OS_RECONCILE_ALERT_SEND") === "1";
}
