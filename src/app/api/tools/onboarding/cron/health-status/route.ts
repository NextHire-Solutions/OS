import { NextResponse } from "next/server";

import { syncHealthStatuses } from "@/lib/tools/onboarding/health";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { cronGate } from "../_auth";

/*
 * Refresh active/paused/churned from Client Health. The tool's
 * `app/api/cron/health-status/route.ts`. The in-process scheduler runs this
 * once a day; this lets an external cron (or a human) force it.
 *   GET https://os.brokerstaffer.com/api/tools/onboarding/cron/health-status
 *   Authorization: Bearer <ONBOARDING_CRON_SECRET>
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  ensureOnboardingScheduler();
  const r = await syncHealthStatuses();
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
