import { safeEqual } from "@/lib/bs-auth";
import type { RunOutcome } from "./runner";

/*
 * The pure half of /api/tools/analytics/sync/run, kept out of the route file
 * so it can be tested without next/server.
 *
 * Two callers, two rules — both the tool's:
 *
 *   - a PERSON, over the workspace session, may run the seven jobs the tool's
 *     own /api/sync/run allowed. sync-entities picks up a campaign created
 *     seconds ago; the deep nightly sweeps take minutes and exist to repair
 *     drift, so a button for them would only ever be a way to hammer
 *     EmailBison by accident.
 *   - a MACHINE, over the bearer secret the tool's /api/cron/<job> checked,
 *     may run any registered job — that is what the same secret unlocked in
 *     the tool, and what an external scheduler needs.
 */

export const MANUAL_JOBS = [
  "sync-entities",
  "sync-steps",
  "sync-senders",
  "sync-replies",
  "sync-leads",
  "sync-outcomes",
  // Bounded by design — one batch off the resolver queue, not a full drain.
  "sync-outcome-attribution",
] as const;

export function isManualJob(job: string): boolean {
  return (MANUAL_JOBS as readonly string[]).includes(job);
}

/** The token after "Bearer ", or "" — never undefined, so it always compares. */
export function bearerToken(header: string | null | undefined): string {
  const value = header ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

/**
 * Whether the Authorization header carries the configured secret.
 *
 * Fails CLOSED: an unset or empty secret authorises nobody, and so does an
 * empty token — the tool's cron route answered 503 to an unset secret rather
 * than treating it as "open".
 */
export function bearerAuthorised(
  header: string | null | undefined,
  secret: string | undefined,
): boolean {
  const presented = bearerToken(header);
  if (!secret || !presented) return false;
  return safeEqual(presented, secret);
}

/**
 * HTTP status for a finished run — the tool's rule, in both of its routes.
 *
 * A failed job returns 500 so a scheduler's own alerting sees it; a skipped one
 * returns 200, because "already running" is the lock working, not a fault.
 * The body is the RunOutcome itself, which is what the screen's describeSync()
 * reads: `status`, `error`, `rowsWritten`, `detail`.
 */
export function runResponseStatus(outcome: Pick<RunOutcome, "status">): 200 | 500 {
  return outcome.status === "error" || outcome.status === "circuit-open" ? 500 : 200;
}

/** The 202 body for `?detach=1` — the tool's cron route, verbatim. */
export function detachedResponse(job: string) {
  return {
    job,
    status: "started",
    detached: true,
    followUp: "/api/tools/analytics/sync/status",
  };
}
