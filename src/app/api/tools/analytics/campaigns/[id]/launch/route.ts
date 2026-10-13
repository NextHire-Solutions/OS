import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { analyticsTeamId } from "@/lib/tools/analytics/supabase";
import { platformOfId } from "@/lib/tools/analytics/campaigns/campaign-id.ts";
import { launchSummary, launchVerdict } from "@/lib/tools/analytics/campaigns/launch.ts";
import { launchCampaign, launchFacts } from "@/lib/tools/analytics/campaigns/launch-load";

/*
 * The Launch tab on one campaign (13 Oct).
 *
 * GET  — what the campaign has right now and whether it can be started. Reads
 *        only; safe to ask as often as the tab is opened.
 * POST — starts it. Confirmed (`confirm: true`), session-named in the audit
 *        log, and the checks are run again here, live, before the one call
 *        that queues real email. See campaigns/launch-load.ts.
 *
 * EmailBison only. Instantly has no campaign running here and its own start
 * call is the existing Resume action.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function target(params: Promise<{ id: string }>) {
  const { id } = await params;
  if (platformOfId(id) !== "emailbison") return null;
  return Number(id);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const campaignId = await target(params);
  if (!campaignId) return NextResponse.json({ error: "Launch is available for EmailBison campaigns." }, { status: 400 });
  try {
    const read = await launchFacts(campaignId, analyticsTeamId());
    if (!read) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    const verdict = launchVerdict(read.facts);
    return NextResponse.json({
      name: read.name,
      facts: read.facts,
      verdict,
      summary: verdict.can && verdict.action ? launchSummary(read.facts, verdict.action) : null,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read this campaign" }, { status: 502 });
  }
}

const Body = z.object({ confirm: z.literal(true) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", cookieStore.get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const campaignId = await target(params);
  if (!campaignId) return NextResponse.json({ error: "Launch is available for EmailBison campaigns." }, { status: 400 });

  if (!Body.safeParse(await request.json().catch(() => null)).success) {
    return NextResponse.json(
      { error: "Launching queues a campaign to send and must be confirmed. Re-send with confirm: true." },
      { status: 428 },
    );
  }

  const outcome = await launchCampaign(campaignId, session.email, analyticsTeamId());
  if (outcome.ok) return NextResponse.json(outcome);
  // 409: refused by the checks, nothing reached EmailBison. 502: EmailBison refused or failed.
  return NextResponse.json(outcome, { status: outcome.verdict ? 409 : 502 });
}
