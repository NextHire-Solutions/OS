import { isSyncDue, syncScheduleEnabled, TICK_EVERY_MS } from "./schedule";
import { syncHealth } from "./health";
import { triggerSync } from "./index";

/*
 * The schedule's heartbeat, running in the SERVER process.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE THE BROWSER TICK
 *
 * `sync/tick/route.ts` lets any open Client Health tab act as a clock: it
 * POSTs once a minute and the server decides whether a run is due. That is
 * honest and safe, and it has one hole the tool's Railway cron never had — a
 * quarter hour at 3am with nobody signed in produces no run at all, and the
 * numbers are then as old as the last tab that was open.
 *
 * This ticker closes that hole. It is started once per Node process from
 * src/instrumentation.ts (the same place the Analytics scheduler starts), so
 * a deploy at 05:59 still fires the 06:00 slot. It makes EXACTLY the decision
 * the tick route makes — enabled, not running, due by slot — through the same
 * functions, so the two clocks can never disagree about whether to run. Both
 * may tick in the same minute; `triggerSync` holds the lock and refuses the
 * second, which is the same outcome as ten tabs ticking today.
 *
 * Gated by CLIENT_HEALTH_SYNC_ENABLED=1 exactly as the tick route is, so a
 * preview deployment with production credentials never starts writing.
 */

const KEY = Symbol.for("brokerstaffer.client-health.sync.scheduler");
const slot = globalThis as unknown as { [KEY]?: { timer: ReturnType<typeof setInterval> } };

export type TickDecision = "disabled" | "running" | "not-due" | "started" | "refused" | "error";

/** The three things the decision depends on, injectable so the table is testable. */
export interface TickDeps {
  enabled: () => boolean;
  health: (now: Date) => Promise<{ running: boolean; lastStartedAt: string | null }>;
  trigger: () => { started: boolean };
}

const liveDeps: TickDeps = {
  enabled: () => syncScheduleEnabled(),
  health: (now) => syncHealth(undefined, now),
  trigger: () => triggerSync("scheduled"),
};

/** One heartbeat: the tick route's decision, without the HTTP. */
export async function tickOnce(now: Date = new Date(), deps: TickDeps = liveDeps): Promise<TickDecision> {
  if (!deps.enabled()) return "disabled";
  let health;
  try {
    health = await deps.health(now);
  } catch {
    return "error";
  }
  if (health.running) return "running";
  if (!isSyncDue(health.lastStartedAt, now)) return "not-due";
  return deps.trigger().started ? "started" : "refused";
}

/** Start the ticker if this process has not already. Idempotent. */
export function ensureClientHealthScheduler(): "started" | "already-running" | "disabled" {
  if (!syncScheduleEnabled()) return "disabled";
  if (slot[KEY]) return "already-running";
  const timer = setInterval(() => {
    void tickOnce().catch(() => {
      // A failed heartbeat is not itself a sync failure; the next one retries
      // and `sync_runs` carries the record of any run that actually broke.
    });
  }, TICK_EVERY_MS);
  // Never keep the process alive just to tick.
  timer.unref?.();
  slot[KEY] = { timer };
  return "started";
}
