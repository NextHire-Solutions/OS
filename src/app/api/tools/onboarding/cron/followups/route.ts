import { NextResponse } from "next/server";

import { recordDueFollowups } from "@/lib/tools/onboarding/followup";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { cronGate } from "../_auth";

/*
 * Step 27 — the follow-up clock. In the tool this SENDS the Touch Base email
 * from the scheduler tick; in the OS a due follow-up is RECORDED as pending
 * enablement (`email / followup_call`, status "pending") and nothing is sent.
 *   GET https://os.brokerstaffer.com/api/tools/onboarding/cron/followups
 *   Authorization: Bearer <ONBOARDING_CRON_SECRET>
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  ensureOnboardingScheduler();
  const r = await recordDueFollowups();
  return NextResponse.json({ ok: true, ...r });
}
