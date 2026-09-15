import { NextResponse } from "next/server";

import { syncBisonImports } from "@/lib/tools/onboarding/db-sync";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { cronGate } from "../_auth";

/*
 * Did the DB app flip bison_campaigns.leads_imported_campaign for any client
 * we're waiting on? The tool's `app/api/cron/check-bison-imports/route.ts`.
 * (Also runs on every client page view.) With the pipeline in automatic mode
 * this launches the campaign whose leads just landed.
 *   GET https://os.brokerstaffer.com/api/tools/onboarding/cron/check-bison-imports
 *   Authorization: Bearer <ONBOARDING_CRON_SECRET>
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  ensureOnboardingScheduler();
  const r = await syncBisonImports();
  return NextResponse.json({ ok: true, ...r });
}
