import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/tools/master-inbox/auth/require-admin";
import { CampaignListError, cleanupOverview, saveSettings } from "@/lib/clients/campaign-lists/sweep";

/*
 * Inbox → Settings → Campaign clean-up (admins only — this decides what comes
 * off clients' live campaigns).
 *
 * GET → the switches, the server's own lock (OS_CAMPAIGN_CLEANUP_LIVE) and
 *       test fence, the clients switched on, and the recent log.
 * PUT → { enabled?, practiceMode?, ifUpdatedAt? }.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  try {
    return NextResponse.json(await cleanupOverview());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the clean-up" }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const body = await request.json().catch(() => null);
  try {
    const settings = await saveSettings(body, session.user.email ?? "unknown");
    console.log(`[campaign-cleanup] ${session.user.email} changed the switches: ${JSON.stringify(body)}`);
    return NextResponse.json({ ok: true, settings });
  } catch (e) {
    if (e instanceof CampaignListError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 502 });
  }
}
