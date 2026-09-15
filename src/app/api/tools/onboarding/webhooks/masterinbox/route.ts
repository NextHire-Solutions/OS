import { NextResponse } from "next/server";

import { handleMasterinboxEvent } from "@/lib/tools/onboarding/connector-bison";
import { onboardingEnv } from "@/lib/tools/onboarding/env";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { queryTokenAccepted } from "@/lib/tools/onboarding/webhook-auth";

/*
 * Masterinbox posts an introduction here when a lead is labelled as an
 * introduction. The tool's `app/api/webhooks/masterinbox/route.ts`.
 *
 *   PUBLIC URL  https://os.brokerstaffer.com/api/tools/onboarding/webhooks/masterinbox[?token=<ONBOARDING_MASTERINBOX_WEBHOOK_TOKEN>]
 *   EVENT       "lead.introduction"; the client is identified by client.portal_url
 *               (stored on the portal push), with slug / name fallbacks.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  ensureOnboardingScheduler();
  if (!queryTokenAccepted(req.url, onboardingEnv("MASTERINBOX_WEBHOOK_TOKEN"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  if (payload?.event !== "lead.introduction") {
    return NextResponse.json({ ok: true, ignored: (payload?.event as string | undefined) ?? "unknown" });
  }
  try {
    return NextResponse.json({ ok: true, ...(await handleMasterinboxEvent(payload)) });
  } catch (e) {
    console.error("masterinbox webhook error", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
