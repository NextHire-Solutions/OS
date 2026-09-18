import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { isAdmin } from "@/lib/identity/admin";
import { workspaceId } from "@/lib/tools/master-inbox/supabase";
import { feedbackSummary } from "@/lib/tools/master-inbox/ai/feedback";
import { backfillStatus, startFeedbackBackfill } from "@/lib/tools/master-inbox/ai/feedback-backfill";

/*
 * The headline number: what happened to the agent's drafts.
 *
 * GET  — as-written / light-edit / rewritten / discarded, plus the baseline the
 *        old agent set, plus whether a backfill is running.
 * POST — start the backfill over every historical draft. It reads every
 *        outbound message in the workspace, so it is a job and this returns at
 *        once; the screen polls GET.
 *
 * Admin-only, like the other two AI routes. The backfill writes ~12,000 rows
 * and is not something to set off from a stray click.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function requireAdmin(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return { error: NextResponse.json({ error: "Not configured." }, { status: 503 }) };
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!isAdmin(session.email)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", detail: "Only workspace admins can see or rebuild the agent's record." },
        { status: 403 },
      ),
    };
  }
  return { session };
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if ("error" in gate) return gate.error;
  try {
    const summary = await feedbackSummary(await workspaceId());
    return NextResponse.json({ ...summary, backfill: backfillStatus() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read the agent's record" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request);
  if ("error" in gate) return gate.error;
  try {
    const result = startFeedbackBackfill(await workspaceId());
    if (!result.started) {
      return NextResponse.json(
        { started: false, reason: result.reason, detail: "A backfill is already running." },
        { status: 409 },
      );
    }
    return NextResponse.json({ started: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not start the backfill" },
      { status: 500 },
    );
  }
}
