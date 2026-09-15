import { NextResponse } from "next/server";

import { handleBisonEvent, handleMasterinboxEvent } from "@/lib/tools/onboarding/connector-bison";
import { onboardingEnv } from "@/lib/tools/onboarding/env";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { queryTokenAccepted } from "@/lib/tools/onboarding/webhook-auth";

/*
 * Introduction webhook. The tool's `app/api/webhooks/bison/route.ts`.
 *
 *   PUBLIC URL  https://os.brokerstaffer.com/api/tools/onboarding/webhooks/bison?token=<ONBOARDING_BISON_WEBHOOK_TOKEN>
 *   AUTH        shared token in the query string (webhooks aren't signed); skipped only while unset
 *
 * Accepts BOTH shapes: a Masterinbox `lead.introduction` event (current trigger)
 * and a legacy Bison `lead_interested` event — so whichever URL was configured
 * keeps working. Records the intro, records the intro_1/2/3 client email as
 * pending enablement, pauses the campaign on the weekly target.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  ensureOnboardingScheduler();
  if (!queryTokenAccepted(req.url, onboardingEnv("BISON_WEBHOOK_TOKEN"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  try {
    const result = payload?.event === "lead.introduction"
      ? await handleMasterinboxEvent(payload)   // Masterinbox format
      : await handleBisonEvent(payload);         // legacy Bison format
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("intro webhook error", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
