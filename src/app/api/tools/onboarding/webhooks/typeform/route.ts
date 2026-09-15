import { NextResponse } from "next/server";

import { handleTypeformIntake } from "@/lib/tools/onboarding/intake";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { verifySignature, type TfPayload } from "@/lib/tools/onboarding/typeform";
import { onboardingEnv } from "@/lib/tools/onboarding/env";

/*
 * Typeform posts here on every submission. The tool's
 * `app/api/webhooks/typeform/route.ts`.
 *
 *   PUBLIC URL  https://os.brokerstaffer.com/api/tools/onboarding/webhooks/typeform
 *   AUTH        Typeform-Signature (HMAC-SHA256 over the raw body) against
 *               ONBOARDING_TYPEFORM_WEBHOOK_SECRET; skipped only while unset.
 *
 * No workspace session: Typeform is not a person. The proxy must let this path
 * through (see src/proxy.ts); the signature is the credential.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  ensureOnboardingScheduler();
  const raw = await req.text();
  const secret = onboardingEnv("TYPEFORM_WEBHOOK_SECRET");

  if (secret) {
    const ok = verifySignature(raw, req.headers.get("typeform-signature"), secret);
    if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }

  try {
    const { clientId, isNew } = await handleTypeformIntake(payload as TfPayload);
    // Downstream pushes (Portal/HealthDash/Bison) are triggered from the UI, or by copy approval.
    return NextResponse.json({ ok: true, clientId, emailed: isNew });
  } catch (e) {
    console.error("typeform intake failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
