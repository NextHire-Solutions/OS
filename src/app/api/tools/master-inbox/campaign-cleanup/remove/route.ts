import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/tools/master-inbox/auth/require-admin";
import { CampaignListError, removeNow } from "@/lib/clients/campaign-lists/sweep";

/*
 * "Remove now" on one recorded entry (admins). Real removals from live
 * campaigns — refused unless OS_CAMPAIGN_CLEANUP_LIVE=1 on this server, and
 * limited to OS_CAMPAIGN_CLEANUP_LIVE_ONLY's campaigns while that is set.
 *
 * POST { id, confirm: true }
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const body = (await request.json().catch(() => null)) as { id?: unknown; confirm?: unknown } | null;
  if (typeof body?.id !== "string") return NextResponse.json({ error: "Which entry?" }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ error: "This takes the person off live campaigns — confirm it." }, { status: 428 });
  try {
    const r = await removeNow(body.id, session.user.email ?? "unknown");
    console.log(`[campaign-cleanup] ${session.user.email} pressed Remove now on ${body.id}: ${r.status}`);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof CampaignListError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not remove" }, { status: 502 });
  }
}
