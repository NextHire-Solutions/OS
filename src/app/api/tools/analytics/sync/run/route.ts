import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { JOB_NAMES, getJob } from "@/lib/tools/analytics/sync/jobs";
import { runJob } from "@/lib/tools/analytics/sync/runner";
import { ensureScheduler } from "@/lib/tools/analytics/sync/scheduler";
import {
  MANUAL_JOBS,
  bearerAuthorised,
  detachedResponse,
  isManualJob,
  runResponseStatus,
} from "@/lib/tools/analytics/sync/manual";
import { analyticsTeamId } from "@/lib/tools/analytics/supabase";
import { optionalEnv } from "@/lib/env";

/*
 * Run a sync job on demand — in process, with the tool's own engine.
 *
 * This route is the tool's /api/sync/run and /api/cron/<job> folded into one:
 * the same `runJob` (same lock, same run history, same circuit breaker), the
 * same job registry, the same response — the RunOutcome as JSON, 500 when the
 * job failed or the breaker is open, 200 when it ran or was skipped because a
 * scheduled run already held the lock.
 *
 * Who may call it:
 *
 *   - the workspace session (the Sync button). The proxy already gates every
 *     /api/tools/* path; the session is read again here for the same reason
 *     the tool did — the run is attributable. Limited to MANUAL_JOBS.
 *   - a bearer ANALYTICS_CRON_SECRET, for machine callers. Any registered job,
 *     and `?detach=1` answers 202 at once and lets the run finish in the
 *     background, exactly as the tool's cron route did for its dispatcher.
 *     NOTE: src/proxy.ts still requires a session on /api/tools/*, so a
 *     machine caller cannot reach this handler today — see the port report.
 *
 * Unlike the proxy version this replaces, nothing here goes over HTTP. There
 * is no ANALYTICS_URL any more: the jobs, the rate limiter and the database
 * lock all live in this process.
 */

export const dynamic = "force-dynamic";
// The deep sweeps make thousands of EmailBison calls; the platform default
// would cut them off mid-run and leave a stale lock behind.
export const maxDuration = 800;

export async function POST(request: NextRequest) {
  ensureScheduler();

  const machine = bearerAuthorised(
    request.headers.get("authorization"),
    optionalEnv("ANALYTICS_CRON_SECRET"),
  );

  if (!machine) {
    const cookieStore = await cookies();
    const session = await verifySessionToken(
      process.env.AUTH_SECRET ?? "",
      cookieStore.get(AUTH_COOKIE)?.value,
    );
    if (!session?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const job = request.nextUrl.searchParams.get("job") ?? "sync-entities";
  if (!machine && !isManualJob(job)) {
    return NextResponse.json(
      { error: `Not runnable from here. Choose one of: ${MANUAL_JOBS.join(", ")}` },
      { status: 400 },
    );
  }

  const fn = getJob(job);
  if (!fn) {
    return NextResponse.json(
      { error: `Unknown job "${job}"`, available: JOB_NAMES },
      { status: 404 },
    );
  }

  const teamId = analyticsTeamId();

  if (machine && request.nextUrl.searchParams.get("detach") === "1") {
    void runJob(job, teamId, fn).catch((error) =>
      console.error(`[cron] ${job} (detached) threw:`, error),
    );
    return NextResponse.json(detachedResponse(job), { status: 202 });
  }

  const outcome = await runJob(job, teamId, fn);
  return NextResponse.json(outcome, { status: runResponseStatus(outcome) });
}

/** Same handler under GET, for schedulers that only issue GETs — as the tool's cron route did. */
export const GET = POST;
