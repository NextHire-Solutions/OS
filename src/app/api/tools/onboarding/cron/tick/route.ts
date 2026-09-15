import { NextResponse } from "next/server";

import { ensureOnboardingScheduler, runSchedulerTick, schedulerStatus } from "@/lib/tools/onboarding/scheduler";
import { cronGate } from "../_auth";

/*
 * One whole scheduler tick, on demand — the same jobs in the same order as the
 * in-process ticker (lib/tools/onboarding/scheduler.ts). This is the one route
 * an external cron needs if it drives everything itself.
 *   GET https://os.brokerstaffer.com/api/tools/onboarding/cron/tick
 *   Authorization: Bearer <ONBOARDING_CRON_SECRET>
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  const started = ensureOnboardingScheduler();
  const report = await runSchedulerTick();
  return NextResponse.json({ ok: true, scheduler: { ...schedulerStatus(), ensure: started }, ...report });
}
