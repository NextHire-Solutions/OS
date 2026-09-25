import { NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { bearerAccepted } from "@/lib/tools/onboarding/webhook-auth";
import { runReconcileCheck } from "@/lib/reconcile/run";

/*
 * Drift detection that comes to you — §16's second half.
 *
 *   "We need to know IMMEDIATELY that there is a synchronization problem."
 *   "We should not have to discover these issues manually."
 *
 * The Consistency screen answered the first line and not the second: it tells
 * you nothing unless you open it.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEDULE IS NOW IN-PROCESS
 *
 * This route used to say "schedule it like the other crons" and nothing ever
 * did, which left the second line unanswered in practice — the checks ran only
 * when somebody called them by hand. The clock now lives in
 * lib/reconcile/scheduler.ts, started from src/instrumentation.ts with every
 * other absorbed schedule, and both it and this route run the same check
 * through lib/reconcile/run.ts.
 *
 * The route stays, for three jobs a scheduler cannot do: reading the current
 * state on demand, forcing a run without waiting for the hour, and asking for a
 * daily all-clear with `&always=1`.
 *
 *   curl -H 'Authorization: Bearer <OS_CRON_SECRET>' \
 *     'https://os.brokerstaffer.com/api/cron/reconcile-alert?send=1'
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 *   * REPORT-ONLY BY DEFAULT. Without ?send=1 it posts nothing and just returns
 *     what it would have said, so the behaviour can be read before anyone wires
 *     up the channel.
 *   * Auth fails CLOSED: no OS_CRON_SECRET, no access. This route reads every
 *     client in four databases.
 *   * Each of the checks is caught separately — see run.ts.
 *   * Slack is best-effort: an unset channel is a no-op, and a Slack failure is
 *     reported in the response rather than failing the run.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(request: Request) {
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("token");
  const auth = bearerAccepted(
    request.headers.get("authorization") ?? (tokenParam ? `Bearer ${tokenParam}` : null),
    optionalEnv("OS_CRON_SECRET"),
  );
  if (auth === "unconfigured") {
    return NextResponse.json(
      { error: "OS_CRON_SECRET is not set — this route is closed" },
      { status: 503 },
    );
  }
  if (auth === "denied") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await runReconcileCheck({
    send: url.searchParams.get("send") === "1",
    always: url.searchParams.get("always") === "1",
  });
  return NextResponse.json(result);
}

export async function GET(request: Request) {
  return run(request);
}
export async function POST(request: Request) {
  return run(request);
}
