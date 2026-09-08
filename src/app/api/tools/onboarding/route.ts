import { NextResponse } from "next/server";

import { getOnboardingPipeline } from "@/lib/tools/onboarding/pipeline";

/*
 * Onboarding's pipeline, for the screen that shows it.
 *
 * Read-only. The live orchestrator keeps receiving its Typeform, Stripe,
 * EmailBison and Calendly webhooks and writing these rows; the workspace only
 * reads what they produce.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  // getOnboardingPipeline already turns failures into a described error rather
  // than throwing, so the screen can say what is wrong instead of showing zeros.
  return NextResponse.json(await getOnboardingPipeline());
}
