import { NextResponse } from "next/server";

import { pollReplies } from "@/lib/tools/onboarding/gmail-replies";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { cronGate } from "../_auth";

/*
 * Poll the connected mailbox for client replies. The tool's
 * `app/api/cron/poll-replies/route.ts`. READS Gmail; sends nothing.
 *   GET https://os.brokerstaffer.com/api/tools/onboarding/cron/poll-replies
 *   Authorization: Bearer <ONBOARDING_CRON_SECRET>
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  ensureOnboardingScheduler();
  try {
    const r = await pollReplies();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
