import { getJob } from "./jobs";
import { runJob, type RunOutcome } from "./runner";
import { dueJobsSince, minuteKey } from "./schedule.ts";
import { analyticsTeamId } from "@/lib/tools/analytics/supabase";

/*
 * The in-process scheduler — ported from the tool's src/lib/sync/scheduler.ts,
 * which was its fallback for environments without a Railway cron service. In
 * the OS it is the ONLY scheduler: there is no cron service, and
 * ANALYTICS_ENABLE_SCHEDULER=1 turns this ticker on.
 *
 * Correctness does not depend on it being the only caller. `runJob` holds a
 * database lock (`sync_state.running_since`), so a second Railway replica, a
 * manual /api/tools/analytics/sync/run call and this ticker can all fire at
 * once and whichever gets there first runs while the rest are "skipped". Note
 * what that lock is: a read-then-upsert on one row, not an atomic compare-and-
 * set. Two replicas reading the row in the same instant can both proceed; the
 * tool accepts that because every job is idempotent, and so does this port.
 *
 * Due-ness is computed from the wall clock by modulo, not from an interval
 * counter, so a restart resumes the same cadence rather than restarting the
 * phase — a crash-looping deploy can't turn the 3-hourly job into a 30-second
 * one.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOW
 *
 * The tool's cron dispatcher (scripts/cron-dispatch.mjs) ran every ten
 * minutes and fired everything that came due in the CRON_WINDOW_MINUTES
 * before it, because a cron container never boots on the exact minute. The
 * tool's own ticker matched one exact minute per tick instead, which is fine
 * while the process is alive and wrong the moment it isn't: a deploy landing
 * at 05:59:50 misses the 06:00 daily sweep, and the only symptom is a "stale"
 * flag thirty hours later.
 *
 * This port keeps both behaviours and lets the window arbitrate between them.
 * Each tick covers every minute since the previous tick — one, normally — and
 * a fresh process covers the whole window, exactly as a fresh cron container
 * did. The window is also the cap: a process that was paused for an hour must
 * not replay the hour. ANALYTICS_CRON_WINDOW_MINUTES=1 restores the tool's
 * exact-minute ticker.
 *
 * The cost of the boot replay is one duplicate run of whatever finished in the
 * last ten minutes before a deploy — extra EmailBison calls and nothing else,
 * the same trade the runner's stale-lock timeout already makes.
 *
 * ---------------------------------------------------------------------------
 * ONCE PER PROCESS
 *
 * There is no src/instrumentation.ts in the OS, so this is started from the
 * analytics sync routes on their first request (see ensureScheduler). Next
 * bundles each route separately, which means a plain module-level flag would
 * be a flag per route and the ticker would start twice; the guard lives on
 * globalThis, which is per process.
 *
 * To DISABLE: unset ANALYTICS_ENABLE_SCHEDULER (or set it to anything but "1")
 * and redeploy. Nothing then runs the jobs — the OS has no cron service — so
 * only do that while another process (the standalone tool, or a machine
 * caller hitting sync/run with the bearer secret) is driving them.
 */

export const TICK_MS = 30_000;
export const DEFAULT_WINDOW_MINUTES = 10;

export type Env = Record<string, string | undefined>;

export function schedulerEnabled(env: Env = process.env): boolean {
  return env.ANALYTICS_ENABLE_SCHEDULER === "1";
}

/** ANALYTICS_CRON_WINDOW_MINUTES, floored to a whole minute, never below one. */
export function windowMinutes(env: Env = process.env): number {
  const n = Number(env.ANALYTICS_CRON_WINDOW_MINUTES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_WINDOW_MINUTES;
}

/**
 * Which jobs one tick should fire, and the minute it leaves covered.
 *
 * Pure, so the whole replay policy above is testable without a clock:
 *
 *   - same minute as the last tick → nothing (the 30s cadence visits each
 *     minute twice; only the first counts);
 *   - normally one minute has passed → exactly that minute;
 *   - a fresh process (no last minute) → the full window;
 *   - a gap of N minutes → N minutes, capped at the window.
 */
export function dueForTick(
  now: Date,
  lastMinute: number | null,
  window: number,
): { due: string[]; minute: number } {
  const minute = minuteKey(now);
  if (lastMinute !== null && minute <= lastMinute) return { due: [], minute: lastMinute };
  const span = lastMinute === null ? window : Math.min(minute - lastMinute, window);
  return { due: dueJobsSince(now, span), minute };
}

export interface TickerOptions {
  /** Runs one job by name. Defaults to `runJob` against the real registry. */
  run?: (job: string) => Promise<RunOutcome>;
  /** Whether a scheduled name is a registered job. Defaults to the registry. */
  known?: (job: string) => boolean;
  windowMinutes?: number;
  log?: (line: string) => void;
}

export interface Ticker {
  /** Fires what is due; returns the names it started. Never throws. */
  tick(now?: Date): string[];
  readonly lastMinute: number | null;
}

function describe(outcome: RunOutcome): string {
  return (
    `[cron] ${outcome.job} ${outcome.status} in ${outcome.durationMs}ms` +
    (outcome.rowsWritten !== undefined ? ` (${outcome.rowsWritten} rows)` : "") +
    (outcome.error ? ` — ${outcome.error}` : "")
  );
}

export function createTicker(options: TickerOptions = {}): Ticker {
  const run =
    options.run ??
    ((job: string) => runJob(job, analyticsTeamId(), getJob(job)!));
  const known = options.known ?? ((job: string) => Boolean(getJob(job)));
  const window = options.windowMinutes ?? windowMinutes();
  const log = options.log ?? ((line: string) => console.log(line));
  let lastMinute: number | null = null;

  return {
    get lastMinute() {
      return lastMinute;
    },
    tick(now = new Date()) {
      const { due, minute } = dueForTick(now, lastMinute, window);
      lastMinute = minute;

      const started: string[] = [];
      for (const job of due) {
        if (!known(job)) continue;
        started.push(job);
        // Deliberately not awaited in series: a 6-minute deep sweep must not
        // delay the 10-minute reply sync behind it.
        void run(job)
          .then((outcome) => {
            if (outcome.status !== "skipped") log(describe(outcome));
          })
          .catch((error) => console.error(`[cron] ${job} threw:`, error));
      }
      return started;
    },
  };
}

const KEY = Symbol.for("brokerstaffer.analytics.sync.scheduler");
type Slot = { ticker: Ticker; timer: ReturnType<typeof setInterval> };
const slots = globalThis as unknown as { [KEY]?: Slot };

/** Starts the ticker if it isn't already running in this process. */
export function startScheduler(options: TickerOptions = {}): Ticker {
  if (slots[KEY]) return slots[KEY].ticker;

  const ticker = createTicker(options);
  const timer = setInterval(() => {
    try {
      ticker.tick();
    } catch (error) {
      console.error("[cron] tick failed:", error);
    }
  }, TICK_MS);
  // Never hold the process open for the sake of the ticker.
  timer.unref?.();
  slots[KEY] = { ticker, timer };

  console.log(
    `[cron] in-process scheduler started — window ${options.windowMinutes ?? windowMinutes()}m`,
  );
  return ticker;
}

export type EnsureResult = "started" | "already-running" | "disabled";

/**
 * What the analytics sync routes call on every request. Cheap after the first:
 * a symbol lookup. Returns what it did so a health line can say so.
 */
export function ensureScheduler(env: Env = process.env): EnsureResult {
  // The Edge runtime has neither the timer semantics we want nor Supabase.
  if (env.NEXT_RUNTIME === "edge") return "disabled";
  if (!schedulerEnabled(env)) return "disabled";
  if (slots[KEY]) return "already-running";
  startScheduler();
  return "started";
}

/** Test hook: tears the process-wide ticker down. */
export function stopScheduler(): void {
  const slot = slots[KEY];
  if (!slot) return;
  clearInterval(slot.timer);
  delete slots[KEY];
}
