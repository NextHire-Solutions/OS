import {
  TICK_EVERY_MS,
  hourUtc,
  isReconcileDue,
  reconcileScheduleEnabled,
  reconcileSendEnabled,
} from "./schedule";
import { runReconcileCheck } from "./run";

/*
 * The heartbeat that makes §16's drift check actually run.
 *
 * Started once per Node process from src/instrumentation.ts, alongside the
 * Analytics, Client Health, Master Inbox and Onboarding schedules. See
 * ./schedule.ts for the cadence, the two switches, and the one limitation of
 * keeping the last-run time in the process rather than in a table.
 */

const KEY = Symbol.for("brokerstaffer.reconcile.alert.scheduler");

interface Slot {
  timer: ReturnType<typeof setInterval>;
  lastRanAt: Date | null;
  running: boolean;
}

const slots = globalThis as unknown as { [KEY]?: Slot };

export type ReconcileTickDecision = "disabled" | "running" | "not-due" | "ran" | "error";

/** The three things the decision depends on, injectable so the table is testable. */
export interface ReconcileTickDeps {
  enabled: () => boolean;
  hour: () => number;
  send: () => boolean;
  run: (options: { send: boolean; always: boolean }) => Promise<unknown>;
}

const liveDeps: ReconcileTickDeps = {
  enabled: () => reconcileScheduleEnabled(),
  hour: () => hourUtc(),
  send: () => reconcileSendEnabled(),
  run: (options) => runReconcileCheck(options),
};

/**
 * One heartbeat.
 *
 * `lastRanAt` is stamped BEFORE the run, not after — the same choice the Client
 * Health schedule makes with `sync_runs.started_at`. A run that throws therefore
 * waits for tomorrow instead of being retried every five minutes: the check
 * already degrades gracefully on its own (each reader is caught separately and a
 * failure is itself reported as urgent), so a thrown error here is exceptional
 * and hammering four databases over it would be the worse failure.
 */
export async function tickOnce(
  now: Date = new Date(),
  deps: ReconcileTickDeps = liveDeps,
  state: { lastRanAt: Date | null; running: boolean } = slots[KEY] ?? {
    lastRanAt: null,
    running: false,
  },
): Promise<ReconcileTickDecision> {
  if (!deps.enabled()) return "disabled";
  if (state.running) return "running";
  if (!isReconcileDue(state.lastRanAt, now, deps.hour())) return "not-due";

  state.lastRanAt = now;
  state.running = true;
  try {
    await deps.run({ send: deps.send(), always: false });
    return "ran";
  } catch {
    return "error";
  } finally {
    state.running = false;
  }
}

/** Start the ticker if this process has not already. Idempotent. */
/** Delay before the start-up check: long enough for the server to finish booting. */
export const BOOT_DELAY_MS = 90 * 1000;

/** The start-up check. Report only, and skipped if a run is already in flight. */
export async function bootCheck(
  deps: Pick<ReconcileTickDeps, "run">,
  state: { running: boolean },
): Promise<"ran" | "running" | "error"> {
  if (state.running) return "running";
  state.running = true;
  try {
    await deps.run({ send: false, always: false });
    return "ran";
  } catch {
    return "error";
  } finally {
    state.running = false;
  }
}

export function ensureReconcileScheduler(): "started" | "already-running" | "disabled" {
  if (!reconcileScheduleEnabled()) return "disabled";
  if (slots[KEY]) return "already-running";

  const slot: Slot = { timer: undefined as unknown as Slot["timer"], lastRanAt: null, running: false };
  slot.timer = setInterval(() => {
    void tickOnce(new Date(), liveDeps, slot).catch(() => {
      // A failed heartbeat is not itself a drift finding; the run's own report
      // carries anything that actually broke.
    });
  }, TICK_EVERY_MS);
  // Never keep the process alive just to tick.
  slot.timer.unref?.();
  slots[KEY] = slot;

  /*
   * One report-only run shortly after start, so Home has a result without
   * waiting for tomorrow's hour. NEVER sends: a deploy must not post a second
   * Slack message the same day. Not counted as the day's run either — the
   * scheduled one still happens at its hour.
   */
  const boot = setTimeout(() => {
    void bootCheck(liveDeps, slot).catch(() => {});
  }, BOOT_DELAY_MS);
  boot.unref?.();
  return "started";
}

/** Test hook: tears the process-wide ticker down. */
export function stopReconcileScheduler(): void {
  const slot = slots[KEY];
  if (!slot) return;
  clearInterval(slot.timer);
  delete slots[KEY];
}
