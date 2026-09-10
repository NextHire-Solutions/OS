import { NextResponse } from "next/server";

import { syncHealthStatuses } from "@/lib/tools/onboarding/health";

/*
 * The manual nudge for the Health Dashboard pull.
 *
 * The orchestrator's scheduler does this daily on its own; this is the same
 * function, run on demand, exactly as the tool's "Refresh now" button does.
 *
 * It READS the Health Dashboard and WRITES only onto `orch_clients` — nothing is
 * ever written back to the dashboard.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  const result = await syncHealthStatuses();
  if (!result.ok) {
    // A missing credential or a refused token is a configuration problem, not a
    // bad request from the browser.
    return NextResponse.json({ error: result.error ?? "refresh failed" }, { status: 502 });
  }
  return NextResponse.json(result);
}
