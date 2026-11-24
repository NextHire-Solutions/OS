import { NextResponse } from "next/server";

import { requireSession, type SessionContext } from "@/lib/auth/workspace";
import { isAdminUser } from "@/lib/identity/admin-db";
import { holdsPage } from "@/lib/identity/named-pages";
import { CampaignListError, clientListView, saveClientListSettings } from "@/lib/clients/campaign-lists/sweep";

/*
 * One client's campaign lists (admins): the switch that lets the clean-up
 * take My Agents and DNC people off this client's campaigns for real, and
 * the EmailBison campaign new Prospects go to.
 *
 * GET → { available, global, server, client, campaigns, recent }
 * PUT → { removeEnabled?, prospectsCampaignId? (null clears), prospectsByMls?, ifUpdatedAt? }
 *
 * Admins; and, by name (named-pages.ts "prospects-campaigns", 24 Nov: Gabriel), the Prospects campaign picks only — a
 * named person's PUT with anything else (the clean-up switch) is refused.
 */
export const dynamic = "force-dynamic";

const PICKS_ONLY = new Set(["prospectsCampaignId", "prospectsByMls", "ifUpdatedAt"]);

async function allowed(): Promise<{ session: SessionContext; admin: boolean } | NextResponse> {
  const session = await requireSession();
  const admin = await isAdminUser(session.user.email);
  if (admin || holdsPage(session.user.email, "prospects-campaigns")) return { session, admin };
  return NextResponse.json({ error: "Only workspace admins can run this." }, { status: 403 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await allowed();
  if (who instanceof NextResponse) return who;
  const { id } = await params;
  try {
    return NextResponse.json(await clientListView(id));
  } catch (e) {
    if (e instanceof CampaignListError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read" }, { status: 502 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await allowed();
  if (who instanceof NextResponse) return who;
  const { session, admin } = who;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!admin && (!body || typeof body !== "object" || Object.keys(body).some((k) => !PICKS_ONLY.has(k)))) {
    return NextResponse.json({ error: "Only workspace admins can change that." }, { status: 403 });
  }
  try {
    const client = await saveClientListSettings(id, body, session.user.email ?? "unknown");
    console.log(`[campaign-cleanup] ${session.user.email} changed client ${id}: ${JSON.stringify(body)}`);
    return NextResponse.json({ ok: true, client });
  } catch (e) {
    if (e instanceof CampaignListError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 502 });
  }
}
