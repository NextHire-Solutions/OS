import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { refreshInboxExtras } from "@/lib/tools/analytics/inbox-extras-load";
import { getJob } from "@/lib/tools/analytics/sync/jobs";
import { runJob } from "@/lib/tools/analytics/sync/runner";
import { analyticsTeamId } from "@/lib/tools/analytics/supabase";

/*
 * The Inboxes page's Sync button (18 Nov): "a button to manually sync or
 * refresh the inbox data from Email Bison".
 *
 * Runs the same job the schedule runs every three hours, `sync-senders`,
 * through the same runner: one lock, so a press while the schedule (or a
 * colleague) is mid-sync answers "skipped" rather than running twice; the same
 * run history; the same circuit breaker. It reads every inbox from EmailBison
 * (status, tags, daily limit, counts) and takes off the list the inboxes
 * EmailBison no longer has. Nothing in EmailBison is changed.
 *
 * Under /inboxes, so the Inboxes switch opens it (tool-paths.ts) — the people
 * who see the page. The general /sync/run needs Campaign Analytics or
 * Campaign Management, which someone with only Inboxes does not hold.
 *
 * After a sync that worked, warmup scores and campaign assignment are read
 * again too (inbox-extras-load.ts), unless the last read is under ten minutes
 * old: that read is about 700 EmailBison requests.
 */

export const dynamic = "force-dynamic";
// About two minutes for ~3,000 inboxes; the platform default would cut it off and leave the lock behind.
export const maxDuration = 800;

const JOB = "sync-senders";
const EXTRAS_MIN_AGE_MS = 10 * 60 * 1000;

export async function POST() {
  const store = await cookies();
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const fn = getJob(JOB);
  if (!fn) return NextResponse.json({ status: "error", error: `The ${JOB} job is not registered` }, { status: 500 });

  const outcome = await runJob(JOB, analyticsTeamId(), fn);
  const extrasRefreshing = outcome.status === "ok" ? refreshInboxExtras(EXTRAS_MIN_AGE_MS) : false;
  // Who pressed it, in the log beside the run history's row.
  console.info(`[inboxes/sync] ${session.email}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ""}`);

  // A failed run is 502 (EmailBison or the database let it down), with the outcome as the body all the same.
  const failed = outcome.status === "error" || outcome.status === "circuit-open";
  return NextResponse.json({ ...outcome, extrasRefreshing }, { status: failed ? 502 : 200 });
}
