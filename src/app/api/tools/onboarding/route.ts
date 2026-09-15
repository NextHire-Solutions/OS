import { NextResponse } from "next/server";

import { getOnboardingPipeline } from "@/lib/tools/onboarding/pipeline";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";

/*
 * Onboarding's pipeline, for the screen that shows it.
 *
 * Read-only. The rows are written by the webhook receivers under ./webhooks and
 * the step actions; this only reads what they produce. Opening the pipeline is
 * also what starts the in-process scheduler when ONBOARDING_CRON_ENABLED=1 —
 * see lib/tools/onboarding/scheduler.ts for why it starts lazily.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  ensureOnboardingScheduler();
  // getOnboardingPipeline already turns failures into a described error rather
  // than throwing, so the screen can say what is wrong instead of showing zeros.
  return NextResponse.json(await getOnboardingPipeline());
}
