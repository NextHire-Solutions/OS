import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/tools/master-inbox/auth/require-admin";
import { CampaignListError, clientListView, saveClientListSettings } from "@/lib/clients/campaign-lists/sweep";

/*
 * One client's campaign lists (admins): the switch that lets the clean-up
 * take My Agents and DNC people off this client's campaigns for real, and
 * the EmailBison campaign new Prospects go to.
 *
 * GET → { available, global, server, client, campaigns, recent }
 * PUT → { removeEnabled?, prospectsCampaignId? (null clears), ifUpdatedAt? }
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const { id } = await params;
  try {
    return NextResponse.json(await clientListView(id));
  } catch (e) {
    if (e instanceof CampaignListError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read" }, { status: 502 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  try {
    const client = await saveClientListSettings(id, body, session.user.email ?? "unknown");
    console.log(`[campaign-cleanup] ${session.user.email} changed client ${id}: ${JSON.stringify(body)}`);
    return NextResponse.json({ ok: true, client });
  } catch (e) {
    if (e instanceof CampaignListError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 502 });
  }
}
