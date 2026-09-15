import { NextResponse, after } from "next/server";

import { authorizeSync } from "@/lib/tools/client-health/sync/auth";
import {
  isSyncDue,
  nextSlotStart,
  syncHealth,
  syncScheduleEnabled,
  triggerSync,
} from "@/lib/tools/client-health/sync";

/*
 * The schedule's heartbeat — the tool's `*​/15 * * * *` Railway cron, restated.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BROWSER TICKS AND THE SERVER DECIDES
 *
 * The tool ran its sync from a separate Railway cron service. The workspace has
 * no cron service, and the two ways to get one — a new service, or a schedule
 * on the web service, which restarts it — are the trade outbox-sweeper.tsx
 * already declined for the same reason. So, as there: a browser that has a
 * Client Health screen open POSTs here about once a minute, and THIS handler
 * holds the rule. The tab is a clock, not a scheduler; it cannot start a run
 * the server thinks is not due, and ten tabs are no different from one.
 *
 * "Due" is the cron's own semantics: one run per quarter-hour slot, judged by
 * `sync_runs.started_at`, which every run already writes. See schedule.ts.
 *
 * The run itself is detached with `after()`: a full sync takes minutes, and a
 * background heartbeat must not hold a browser request open for that long. The
 * response says what was decided; the run finishes on its own and the next
 * tick reads its result off `sync_runs`.
 *
 * What this does NOT cover: a quarter hour at 3am with nobody signed in. The
 * numbers are then as old as the last tab that was open — and every screen
 * says so, in the "Synced N ago" line next to the button. If that ever
 * matters, a Railway cron POSTing here with `x-sync-secret` gets the schedule
 * back with no other change; `authorizeSync` already accepts it.
 *
 * Gated by CLIENT_HEALTH_SYNC_ENABLED=1, so a preview deployment with
 * production credentials never starts writing on its own.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!(await authorizeSync(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!syncScheduleEnabled()) {
    return NextResponse.json({ ok: true, scheduled: false, reason: "disabled" });
  }

  const now = new Date();
  let health;
  try {
    health = await syncHealth(undefined, now);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }

  if (health.running) {
    return NextResponse.json({ ok: true, scheduled: false, reason: "running" });
  }
  if (!isSyncDue(health.lastStartedAt, now)) {
    return NextResponse.json({
      ok: true,
      scheduled: false,
      reason: "not-due",
      nextDueAt: nextSlotStart(now).toISOString(),
    });
  }

  const outcome = triggerSync("scheduled");
  if (!outcome.started) {
    return NextResponse.json({ ok: true, scheduled: false, reason: "running" });
  }

  /*
   * Keep the run alive past the response. The result is not returned — it is
   * written to sync_runs by the run itself, per source, and the errors are
   * logged the way the tool's cron logged them.
   */
  after(async () => {
    try {
      const result = await outcome.result;
      const anyOk = result.instantly.ok || result.bison.ok || result.corofy.ok;
      if (!anyOk) console.error("[client-health sync] all sources failed", result);
    } catch (err) {
      console.error("[client-health sync] scheduled run threw", err);
    }
  });

  return NextResponse.json({ ok: true, scheduled: true, startedAt: now.toISOString() }, { status: 202 });
}
