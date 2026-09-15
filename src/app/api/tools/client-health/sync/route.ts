import { NextResponse } from "next/server";

import { authorizeSync } from "@/lib/tools/client-health/sync/auth";
import { syncHealth, triggerSync } from "@/lib/tools/client-health/sync";

/*
 * "Sync now" — Client Health's sync worker, run IN THIS PROCESS.
 *
 * ---------------------------------------------------------------------------
 * THIS USED TO BE A PROXY
 *
 * It signed in to the live Client Health app as a person and pressed that
 * app's own button, on the reasoning that a second implementation of the sync
 * would drift. That reasoning held while the tool was running. The tool is
 * being switched off, and its sync-worker with it, so the worker moved here:
 * `src/lib/tools/client-health/sync/` is the tool's `scripts/sync.ts` and its
 * four source clients, ported step for step against the same tables.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY CALL IT
 *
 * The tool's POST /api/sync/run accepted `x-sync-secret` when SYNC_SECRET was
 * set and anyone when it was not. Here: the workspace session (the button), or
 * CLIENT_HEALTH_SYNC_SECRET — and an unset secret closes that path rather than
 * opening it. See sync/auth.ts.
 *
 * ---------------------------------------------------------------------------
 * ONE AT A TIME
 *
 * A second press while a run is in flight gets 409, not a second run. The
 * button already disables itself; this is for the case the button cannot see —
 * a scheduled tick that started thirty seconds ago, or a colleague's tab.
 *
 * Slow by nature — thousands of upstream calls — hence the long limit. The
 * response shape is the tool's: `{ ok: true, result }`, which the SyncButton's
 * `describeSync` reads for its "Synced · N campaigns · M intros" toast.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!(await authorizeSync(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const outcome = triggerSync("manual");
  if (!outcome.started) {
    return NextResponse.json(
      {
        ok: false,
        error: "A sync is already running — wait for it to finish rather than starting another.",
        busySince: outcome.busySince?.toISOString() ?? null,
      },
      { status: 409 },
    );
  }

  try {
    const result = await outcome.result;
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

/** Sync health for the screens' "Synced N min ago" line. Session only. */
export async function GET(request: Request) {
  if (!(await authorizeSync(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await syncHealth());
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
